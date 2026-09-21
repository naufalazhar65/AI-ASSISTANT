// workflow_fuzz — business-logic state-transition fuzzer (orchestrated on top of
// the flow primitives: same step runner, same {{var}} substitution, same scope
// gate). Real-money bugs (skip payment step, refund twice, negative quantity,
// coupon reuse, reorder) are invisible to signature scanners — this mutates the
// SEQUENCE and the VALUES of a multi-step flow and diffs outcomes.
//
// Usage: define the HAPPY-PATH flow once (inline steps or a saved flow name),
// then this tool runs bounded mutations:
//   • skip      — drop one step (e.g. no /pay, straight to /receipt)
//   • repeat    — run one step twice (e.g. /refund two times → double refund)
//   • reorder   — swap two adjacent steps (e.g. /receipt before /pay)
//   • value     — inject value payloads into a chosen step's body (qty -1,
//                 price 0/0.01, currency swap, coupon reuse)
// Every mutation's verdict compares against the happy-path outcome; differences
// are honest SIGNALS (they still need poc_verify before finding_add).
import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";
import { recordHttp } from "./httpHistory";
import { substitute, getPath, listFlows, type Flow, type FlowStep } from "./flow";
import { createHash } from "node:crypto";

const UA = "mia-assistant/1.0";
const MAX_MUTATIONS = 14;
const MAX_STEPS = 10;
const CAP = 2000;

export type StepResult = { status: number; body: string; digest: string; ms: number; error?: string };

/** Value payloads for `value` mutations (business-logic flavored). Pure — tested. */
export const VALUE_PAYLOADS: { name: string; patch: (body: string) => string }[] = [
  { name: "qty:-1", patch: (b) => b.replace(/"qty"\s*:\s*\d+/g, '"qty":-1').replace(/"quantity"\s*:\s*\d+/g, '"quantity":-1') },
  { name: "qty:0", patch: (b) => b.replace(/"qty"\s*:\s*\d+/g, '"qty":0').replace(/"quantity"\s*:\s*\d+/g, '"quantity":0') },
  { name: "qty:99999", patch: (b) => b.replace(/"qty"\s*:\s*\d+/g, '"qty":99999').replace(/"quantity"\s*:\s*\d+/g, '"quantity":99999') },
  { name: "amount:0", patch: (b) => b.replace(/"(amount|total|price)"\s*:\s*[\d.]+/g, '"$1":0') },
  { name: "amount:0.01", patch: (b) => b.replace(/"(amount|total|price)"\s*:\s*[\d.]+/g, '"$1":0.01') },
  { name: "amount:negative", patch: (b) => b.replace(/"(amount|total|price)"\s*:\s*([\d.]+)/g, '"$1":-2') },
  { name: "currency:XXX", patch: (b) => b.replace(/"currency"\s*:\s*"[A-Z]{3}"/g, '"currency":"XXX"') },
  { name: "coupon:reuse", patch: (b) => b.replace(/"(coupon|promo|voucher)"\s*:\s*"/g, '"$1":"' ) },
];

/** Sequence mutations over a happy path. Pure — unit-tested. */
export function sequenceMutations(steps: FlowStep[]): { kind: string; at: number; steps: FlowStep[] }[] {
  const out: { kind: string; at: number; steps: FlowStep[] }[] = [];
  if (steps.length < 2) return out;
  for (let i = 0; i < steps.length; i++) {
    const skipped = steps.filter((_, j) => j !== i);
    out.push({ kind: "skip", at: i, steps: skipped });
  }
  for (let i = 0; i < steps.length; i++) {
    const repeated = [...steps.slice(0, i), steps[i], steps[i], ...steps.slice(i + 1)];
    out.push({ kind: "repeat", at: i, steps: repeated });
  }
  for (let i = 0; i < steps.length - 1; i++) {
    const swapped = [...steps];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    out.push({ kind: "reorder", at: i, steps: swapped });
  }
  return out;
}

/** Cap the mutation list deterministically (keep kinds interleaved). Pure. */
export function capMutations<T>(muts: T[], max: number): T[] {
  if (muts.length <= max) return muts;
  const step = muts.length / max;
  return Array.from({ length: max }, (_, i) => muts[Math.floor(i * step)]);
}

/** Apply a value payload to the step at index `at`. Pure. */
export function applyValueMutation(steps: FlowStep[], at: number, payloadIdx: number): FlowStep[] {
  const p = VALUE_PAYLOADS[payloadIdx % VALUE_PAYLOADS.length];
  const next = [...steps];
  const s = next[at];
  next[at] = {
    ...s,
    body: typeof s.body === "string" ? p.patch(s.body) : s.body === undefined ? s.body : p.patch(JSON.stringify(s.body)),
  };
  return next;
}

async function runSteps(rawUser: unknown, steps: FlowStep[], vars: Record<string, string>): Promise<{ ok: boolean; results: StepResult[]; vars: Record<string, string>; failAt: number; why: string }> {
  const results: StepResult[] = [];
  const v: Record<string, string> = { ...vars };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const method = (step.method || "GET").toUpperCase();
    const url = substitute(step.url, v);
    if (!/^https?:\/\//i.test(url) || !targetAllowed(url)) return { ok: false, results, vars: v, failAt: i, why: `SCOPE/url: ${url.slice(0, 80)}` };
    const headers: Record<string, string> = { "User-Agent": UA };
    for (const [k, val] of Object.entries(step.headers || {})) headers[k] = substitute(val, v);
    if (step.session) {
      const s = sessionHeaders(rawUser, step.session);
      if (!s) return { ok: false, results, vars: v, failAt: i, why: `session "${step.session}" tidak ada` };
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["cookie"] = s.cookie;
    }
    let bodyStr: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const raw = typeof step.body === "string" ? step.body : step.body === undefined ? "" : JSON.stringify(step.body);
      bodyStr = substitute(raw, v);
    }
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method, headers, body: bodyStr, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      const r: StepResult = { status: res.status, body: body.slice(0, CAP), digest: createHash("sha256").update(body).digest("hex").slice(0, 12), ms: Date.now() - t0 };
      results.push(r);
      recordHttp(rawUser, { method, url, status: r.status, bytes: body.length, ms: r.ms, at: new Date().toISOString() });
      if (step.expect_status !== undefined && r.status !== step.expect_status) return { ok: false, results, vars: v, failAt: i, why: `status ${r.status} ≠ ${step.expect_status}` };
      if (step.expect_contains && !r.body.includes(step.expect_contains)) return { ok: false, results, vars: v, failAt: i, why: `expect_contains miss` };
      for (const [name, spec] of Object.entries(step.extract || {})) {
        let val: string | undefined;
        if (spec.startsWith("regex:")) {
          const m = r.body.match(new RegExp(spec.slice(6)));
          val = m?.[1] ?? m?.[0];
        } else {
          try { val = getPath(JSON.parse(r.body), spec); } catch { val = undefined; }
        }
        if (val !== undefined) v[name] = val;
      }
      await politeDelay();
    } catch (e) {
      return { ok: false, results, vars: v, failAt: i, why: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, results, vars: v, failAt: -1, why: "" };
}

/** Outcome signature of a run (what the verdict diff compares). Pure. */
export function outcomeSignature(run: { ok: boolean; results: StepResult[]; failAt: number; why?: string }): string {
  if (!run.ok) return `fail@${run.failAt}`;
  return run.results.map((r) => `${r.status}:${r.digest}`).join("|");
}

/** Classify one mutation vs the happy path. Pure — unit-tested. */
export function classifyMutation(base: { ok: boolean; results: StepResult[]; failAt: number }, mut: { ok: boolean; results: StepResult[]; failAt: number; why?: string }, kind: string): { level: "signal" | "info" | "match"; note: string } {
  const sigB = outcomeSignature(base);
  const sigM = outcomeSignature(mut);
  if (sigB === sigM) return { level: "match", note: "outcome identik dengan happy path (mutasi tidak berpengaruh)." };
  if (kind === "repeat" && mut.ok && base.ok) {
    const lastB = base.results[base.results.length - 1];
    const lastM = mut.results[mut.results.length - 1];
    if (lastB && lastM && lastB.status === lastM.status && lastB.status >= 200 && lastB.status < 300 && lastB.digest === lastM.digest && lastB.body.length > 0) {
      return { level: "signal", note: `⚠️ step TERAKHIR diterima IDENTIK saat diulang (status ${lastM.status}) — kandidat double-processing (refund/transfer/coupon dobel). Cek efek nyata (saldo/record).` };
    }
  }
  if ((kind === "skip" || kind === "reorder") && mut.ok && base.ok) {
    const lastB = base.results[base.results.length - 1];
    const lastM = mut.results[mut.results.length - 1];
    if (lastB && lastM && lastM.status >= 200 && lastM.status < 300) {
      return { level: "signal", note: `⚠️ alur TETAP SELESAI walau ${kind === "skip" ? "ada step yang DILEWATI" : "urutan DITUKAR"} (final ${lastM.status}) — kandidat missing state validation (mis. checkout tanpa bayar).` };
    }
  }
  if (!base.ok && !mut.ok) {
    return { level: "info", note: `kedua run gagal (base@${base.failAt}, mutasi@${mut.failAt}) — perbaiki flow dulu.` };
  }
  return { level: "info", note: mut.ok ? `outcome BERBEDA dari happy path (final ${mut.results[mut.results.length - 1]?.status ?? "?"} vs ${base.results[base.results.length - 1]?.status ?? "?"}) — cek apakah perbedaannya bermakna (bukan token/timestamp dinamis).` : `mutasi ditolak di step ${mut.failAt} (${mut.why}) — kontrol mungkin ada (atau flow rusak).` };
}

export async function workflowFuzz(rawUser: unknown, opts: { flow?: Flow; name?: string; vars?: Record<string, string>; focus_step?: number; kinds?: string[]; max?: number }): Promise<string> {
  let flow = opts.flow;
  if (!flow && opts.name) {
    flow = listFlows(rawUser)[opts.name];
    if (!flow) return `Error: flow "${opts.name}" tidak ada.`;
  }
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length < 2) return "Error: butuh flow ≥2 langkah (inline `steps` atau `name` tersimpan dari flow_run save=).";
  if (flow.steps.length > MAX_STEPS) return `Error: terlalu banyak langkah (maks ${MAX_STEPS}) — pecah alurnya.`;
  const urls = flow.steps.map((s) => substitute(s.url, flow!.vars || {}));
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u) || !targetAllowed(u)) return `Error: SCOPE — ${u.slice(0, 80)} bukan lab/engagement aktif.`;
  }
  const kinds = opts.kinds?.length ? opts.kinds : ["skip", "repeat", "reorder", "value"];
  await politeDelay();

  // 1) Happy path (the control)
  const base = await runSteps(rawUser, flow.steps, { ...(flow.vars || {}), ...(opts.vars || {}) });
  if (!base.ok) {
    return `❌ Happy path GAGAL di step ${base.failAt + 1} (${base.why}) — flow harus sukses dulu sebelum difuzz (perbaiki session/extract/expect).`;
  }
  const baseSig = outcomeSignature(base);
  const lines: string[] = [
    `🧩 WORKFLOW FUZZ ${flow.name || "(inline)"} — ${flow.steps.length} langkah, happy path OK (${flow.steps.length} step, sig ${baseSig.slice(0, 20)}…).`,
  ];
  const focus = opts.focus_step !== undefined ? Math.min(flow.steps.length - 1, Math.max(0, opts.focus_step)) : flow.steps.length - 1;

  // 2) Mutations
  const muts: { kind: string; label: string; steps: FlowStep[] }[] = [];
  for (const m of sequenceMutations(flow.steps)) {
    if (kinds.includes(m.kind)) muts.push({ kind: m.kind, label: `${m.kind}@${m.at}`, steps: m.steps });
  }
  if (kinds.includes("value")) {
    for (let pi = 0; pi < VALUE_PAYLOADS.length; pi++) {
      muts.push({ kind: "value", label: `${VALUE_PAYLOADS[pi].name}@${focus}`, steps: applyValueMutation(flow.steps, focus, pi) });
    }
  }
  const capped = capMutations(muts, Math.max(4, Math.min(MAX_MUTATIONS, opts.max ?? MAX_MUTATIONS)));
  lines.push(`Mutasi dijalankan: ${capped.length} (dari ${muts.length} kandidat).`);

  const signals: string[] = [];
  let ran = 0;
  for (const m of capped) {
    const r = await runSteps(rawUser, m.steps, { ...(flow.vars || {}), ...(opts.vars || {}) });
    ran++;
    const verdict = classifyMutation(base, r, m.kind);
    const line = `• [${m.label}] ${verdict.level === "signal" ? "🚨" : verdict.level === "match" ? "·" : "?"} ${verdict.note}`;
    lines.push(line);
    if (verdict.level === "signal") signals.push(line);
    await politeDelay();
  }

  lines.push(`\n━━ Ringkasan ━━`);
  lines.push(`${ran} mutasi · ${signals.length} sinyal bermakna · happy path ${base.ok ? "OK" : "GAGAL"}.`);
  if (!signals.length) lines.push("Tidak ada indikasi business-logic bug dari mutasi ini — coba flow lain / focus_step lain / payload value lain.");
  lines.push(`\n⚠️ Sinyal ≠ exploit: bukti harus efek nyata (saldo/record/status order). poc_verify → finding_add (kategori business logic, CWE-840/841).`);
  return lines.join("\n");
}
