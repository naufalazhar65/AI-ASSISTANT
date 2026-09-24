// LIVE drill — xxe_chain via exploit_chain (ONE confirmation) to the Kohona lab
// with a REAL DNS-OAST callback (interactsh), production path (openrouter +
// confirm_calls, audit-log proof).
//
// Recon first (curl): Kohona endpoints reject/ignore XML (no XML parser) — so
// the honest expectation is: chain RUNS fully, OOB payloads fire with the
// DNS-attributed callback, verdict = NO signal (lab not XXE-vulnerable). The
// OOB MECHANISM is separately proven with a toy /api/import endpoint that
// really parses XML (libxmljs-free: regex-based entity resolver is enough to
// fire a server-side fetch) and resolves the OOB entity server-side.
//
// Callback attribution: operator passes callback="p1-xxe.<oast-domain>" — the
// interactsh poll then NAMES the carrier (p1-xxe) proving the XXE fired (vs the
// generic sanity probe p9-sanity which cannot appear here).
//
// tsx does NOT load .env.local; run from REPO ROOT (sibling drill gotcha).
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");
const { executeTool } = await import("./src/lib/tools");

const USER = `verify_xxeoast_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

function auditToolRuns(user: string, name: string): string[] {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l.includes(`"user":"${user}"`) && l.includes(`"action":"tool:${name}"`)) hits.push(l.slice(0, 140));
    }
  }
  return hits;
}

// ── Toy XML surface: REALLY parses entities server-side (libxml-free) ──
// - resolves <!ENTITY x SYSTEM "…"> by FETCHING the URI server-side (proof of
//   SSRF/XXE resolve), then inlines a stub
// - HTTP fetch proves full egress; DNS-only hosts still resolve → callback
const http = await import("node:http");
let toyFetches = 0;
const toy = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c; });
  req.on("end", async () => {
    if (!req.url?.startsWith("/api/import")) { res.writeHead(404); res.end("nope"); return; }
    const decl = /<!ENTITY\s+(\w+)\s+SYSTEM\s+"([^"]+)"/.exec(body);
    const ref = decl?.[1];
    const uri = decl?.[2];
    if (decl && ref && uri && body.includes(`&${ref};`)) {
      console.log(`  [toy] resolving entity → ${uri.slice(0, 90)}`);
      toyFetches++;
      try {
        const r = await fetch(uri, { signal: AbortSignal.timeout(6000) });
        await r.text().catch(() => {});
        body = body.replace(`&${ref};`, "[resolved]");
      } catch (e) { body = body.replace(`&${ref};`, "[fetch-failed]"); console.log(`  [toy] fetch failed: ${String(e).slice(0, 80)}`); }
    }
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<r><status>ok</status><echo>${body.replace(/[<>&]/g, "")}</echo></r>`);
  });
});
await new Promise<void>((r) => toy.listen(0, "127.0.0.1", () => r()));
const toyBase = `http://127.0.0.1:${(toy.address() as { port: number }).port}`;

try {
  // ── 1) DNS-OAST domain via the tool path ──
  const created = await executeTool({ id: "o1", name: "oast_dns", arguments: JSON.stringify({ action: "create" }) }, USER);
  const dom = /domain unik:\s*(\S+)/.exec(created)?.[1] || "";
  ok(!!dom, "interactsh domain obtained", dom || "(none)");
  if (!dom) throw new Error("no OAST domain");
  // attributed carrier for the XXE chain — WITH scheme: a scheme-less SYSTEM URI
  // fails Node-fetch pre-DNS ("Failed to parse URL"), so the DNS query never
  // fires. http:// still proves DNS OOB (the hostname must resolve first).
  const dnsCallback = `http://p1-xxe.${dom}`;

  // ── 2) P1: PROPOSE via a real openrouter turn (Discord contract) ──
  console.log("\n── P1: propose exploit_chain chain=xxe (openrouter) ──");
  const askBase = `uji XXE di endpoint import XML ${toyBase}/api/import sekaligus endpoint lab ${LAB}/api/pengaduan — jalankan exploit_chain chain=xxe url=${LAB}/api/pengaduan dengan callback=${dnsCallback} dan body_template berisi {XXE} di dalam elemen <pengaduan><isi>{XXE}</isi></pengaduan>`;
  type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;
  let r1: Turn | undefined;
  let finalAsk = askBase;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ask = attempt === 1 ? askBase : `${askBase}. PANGGIL tool exploit_chain-nya sekarang — jangan menarasikan usulannya.`;
    r1 = await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "openrouter", user: USER, channel: "discord" });
    finalAsk = ask;
    const names = (r1.needsConfirmation || []).map((c) => c.name);
    console.log(`attempt ${attempt}: proposed:`, names.join(",") || "(none)", "| head:", (r1.text || "").slice(0, 100));
    if (names.includes("exploit_chain")) break;
  }
  const call = (r1!.needsConfirmation || []).find((c) => c.name === "exploit_chain");
  ok(!!call, "P1: model proposed exploit_chain", (r1!.text || "").slice(0, 100));
  ok(auditToolRuns(USER, "exploit_chain").length === 0, "P1: zero execution before approval");
  if (!call) throw new Error("no exploit_chain proposal");

  // ── 3) P2: APPROVE → chain executes against BOTH surfaces ──
  console.log("\n── P2: approve → execute ──");
  // Operator second call (same one confirmation): point the chain at the toy
  // XML-parsing surface with the DNS-attributed callback.
  // POST-FIX (2026-09-24): the LIB now canonicalizes both shapes at the
  // boundary (normalizeToolCall on decisions + normalizeMessageToolCalls on
  // messages), so drills can send plain TOP-LEVEL calls again — the dual-shape
  // workaround lives only in git history. This run also proves the gateway
  // accepts the replay (no more 400 → real narration, not the digest fallback).
  type ProposedCall = { id?: string; arguments?: string };
  const prop = call as ProposedCall;
  const mk = (id: string, args: unknown) => ({ id, type: "function" as const, name: "exploit_chain", arguments: JSON.stringify(args) });
  let modelArgs: Record<string, unknown> = { chain: "xxe", url: `${LAB}/api/pengaduan`, callback: dnsCallback };
  try { if (prop.arguments) modelArgs = JSON.parse(prop.arguments) as Record<string, unknown>; } catch { /* keep default */ }
  const callDual = mk(prop.id || "c-x", modelArgs);
  const callToy = mk(`${prop.id || "c-x"}-toy`, { chain: "xxe", url: `${toyBase}/api/import`, callback: dnsCallback, method: "POST", content_type: "application/xml", body_template: "<import><data>{XXE}</data></import>" });
  const r2 = await runAssistantTurn({
    messages: [
      { role: "user", content: finalAsk },
      { role: "assistant", content: null, tool_calls: [call, callToy] },
    ],
    provider: "openrouter",
    user: USER,
    channel: "discord",
    confirm_calls: [
      { call: callDual, allow: true },
      { call: callToy, allow: true },
    ],
  });

  console.log("\n=== P2 turn output (truncated) ===");
  console.log((r2.text || "").slice(0, 1800));
  console.log("==================================");

  // ── 4) Assertions: audit + OAST poll + toy fetches (NOT prose) ──
  const runs = auditToolRuns(USER, "exploit_chain");
  ok(runs.length >= 1, "audit tool:exploit_chain EXECUTED", `${runs.length} run(s)`);
  ok(!(r2.needsConfirmation || []).length, "no pending confirmation left");
  const deniesRun = /tidak (bisa |dapat )?(jalankan|eksekusi|dijalankan)|belum (aku |ku )?(jalankan|eksekusi)/i.test(r2.text || "");
  ok(!deniesRun, "narration never denies the executed run");

  // give interactsh several poll cycles, then read interactions via the tool
  await new Promise((r) => setTimeout(r, 15000));
  let poll = await executeTool({ id: "o2", name: "oast_dns", arguments: JSON.stringify({ action: "poll" }) }, USER);
  if (!/p1-xxe/i.test(poll)) {
    await new Promise((r) => setTimeout(r, 10000));
    poll = await executeTool({ id: "o2b", name: "oast_dns", arguments: JSON.stringify({ action: "poll" }) }, USER);
  }
  console.log("\n=== oast_dns poll ===\n" + poll.split("\n").slice(0, 10).join("\n"));
  ok(/p1-xxe/i.test(poll), "OOB DNS callback captured with p1-xxe attribution (XXE proof)");
  ok(/p9-sanity/.test(poll) === false, "sanity probe absent (attribution is specific)");
  ok(toyFetches >= 2, "toy XML parser really resolved the OOB entities server-side", `${toyFetches} fetch(es)`);
} finally {
  try { await executeTool({ id: "o3", name: "oast_dns", arguments: JSON.stringify({ action: "stop" }) }, USER); } catch { /* noop */ }
  toy.close();
  rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
}
console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
