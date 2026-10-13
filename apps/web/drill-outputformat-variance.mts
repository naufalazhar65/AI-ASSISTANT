/**
 * Drill: does the FORMAT instruction survive on a bigger model?
 *
 * Question this answers (live 2026-10-13): the output formatter's classification
 * and renderer are deterministic — 3 identical asks gave the same task type 3/3
 * and the renderer ran 3/3 — but the model only produced the requested shape
 * 1 of 3 times. Groq is not an option (owner), yet the SAME 9router proxy serves
 * larger models, so this measures format compliance per model instead of
 * guessing.
 *
 * Method: ONE identical ask, N runs per model, count how often the answer carries
 * at least 2 recognised section labels. Same user key per model (throwaway), no
 * config change, no owner data touched.
 *
 * Gotcha rumah: probe tsx does NOT load .env.local, so env is loaded by hand.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v && !process.env[m[1]]) process.env[m[1]] = v;
}

const { runAssistantTurn } = await import("./src/lib/agent");
const { countSectionLabels } = await import("./src/lib/outputFormat");

const ASK = "@Agnes ada topik viral disosmed ga hari ini?";
const RUNS = Number(process.env.DRILL_RUNS ?? "3");

// Baseline first (what Discord uses today), then bigger candidates from the same
// proxy. No Groq: the owner does not use it at all.
const MODELS = (process.env.DRILL_MODELS ??
  "gemini/gemini-3.5-flash-lite,gemini/gemma-4-31b-it,ps/laguna-s-2.1,nvidia/nemotron-3-ultra-550b-a55b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const rows: Array<{ model: string; ok: number; runs: number; errs: number; labels: number[]; ms: number[] }> = [];

for (const model of MODELS) {
  let ok = 0;
  let errs = 0;
  const labels: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = Date.now();
    try {
      const r = await runAssistantTurn({
        messages: [{ role: "user", content: ASK }],
        provider: "9router",
        model,
        user: "verify_of_fmtvar",
        channel: "discord",
        agent: "agnes",
      });
      const n = countSectionLabels(r.text || "");
      labels.push(n);
      ms.push(Date.now() - t0);
      if (n >= 2) ok += 1;
      console.log(`  ${model} run${i + 1}: labels=${n} lines=${(r.text || "").split("\n").filter((l) => l.trim()).length} ${Date.now() - t0}ms`);
    } catch (err) {
      errs += 1;
      console.log(`  ${model} run${i + 1}: ERROR ${err instanceof Error ? err.message.slice(0, 90) : String(err).slice(0, 90)}`);
    }
  }
  rows.push({ model, ok, runs: RUNS, errs, labels, ms });
  console.log(`=> ${model}: ${ok}/${RUNS} terstruktur${errs ? ` (${errs} error)` : ""}`);
}

console.log("\n=== RINGKASAN ===");
for (const r of rows) {
  const avg = r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : 0;
  console.log(
    `${r.ok}/${r.runs}  avg=${avg}ms  labels=[${r.labels.join(",")}]  ${r.model}${r.errs ? `  ERR=${r.errs}` : ""}`,
  );
}
const best = [...rows].filter((r) => r.runs > r.errs).sort((a, b) => b.ok / b.runs - a.ok / a.runs)[0];
if (best) console.log(`\nterbaik: ${best.model} (${best.ok}/${best.runs})`);