// LIVE drill (production path, 9router) — REAL narration (not the digest
// fallback) on the narration turn, with the reading-prover-results playbook
// loaded during it.
//
// Owner ask: "Ulangi drill narasi via 9router/groq untuk membuktikan narasi
// real (bukan digest) saat narasi turn".
//
// Why 9router: openrouter free-tier daily quota is exhausted today (429), and
// groq primary is still 413 ITPM (payload 43k > 7k; documented residual) with
// its failover landing on 9router anyway. 9router is the stable daily provider
// AND the production Discord provider.
//
// Design:
//   P0  9router-64 delivery: prover tools in-window (http_request, poc_verify,
//       idor_enum), exploit_chain OUT (slim CHAINS rule: manual flow instead).
//   P1  propose (real LLM turn): ask for an IDOR test on the lab's /api/cek-nik
//       — expect http_request/idor_enum/poc_verify as needsConfirmation
//       (write/confirm) OR direct execution for read-auto tools.
//   P2  approve (confirm_calls) → execution + the NARRATION turn. Assertion:
//       the reply is REAL narration (matches the executed work, no digest
//       marker), and honest about the verdict class (signal vs confirmed).
//
// tsx does NOT load .env.local — parse manually (repo gotcha).
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn, toolsForUrl } = await import("./src/lib/agent");

const USER = `verify_narrdrill_${Date.now()}`; // run-unique: audit log is append-only/shared
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ASK = `uji IDOR di ${LAB}/api/cek-nik?id=1 — coba ganti id ke angka lain dan bandingkan responsnya, lalu jelaskan hasilnya: ini cuma sinyal atau sudah temuan terkonfirmasi?`;

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

// ── Audit-log proof helper (house rule: proof = audit log, not prose) ──
function auditToolRuns(user: string, name: string): string[] {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l.includes(`"user":"${user}"`) && l.includes(`"action":"tool:${name}"`)) hits.push(l);
    }
  }
  return hits;
}

// ── P0: 9router-64 delivery matrix ──
console.log("── P0: 9router delivery matrix ──");
const r9 = toolsForUrl("http://127.0.0.1:20128/v1/chat/completions").map((t: { function: { name: string } }) => t.function.name);
for (const t of ["http_request", "poc_verify", "security_playbook", "finding_list"]) {
  ok(r9.includes(t), `9router-64 carries ${t}`);
}
ok(!r9.includes("exploit_chain"), "exploit_chain not on 9router-64 (manual CHAINS rule applies)");

// ── P1: propose via a real 9router LLM turn ──
console.log("\n── P1: propose (9router, channel discord) ──");
type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;
let r1: Turn | undefined;
let finalAsk = ASK;
let r1Text = "";
for (let attempt = 1; attempt <= 3; attempt++) {
  const ask = attempt === 1
    ? ASK
    : `${ASK} PANGGIL tool ujinya sekarang (http_request/poc_verify) — jangan cukup menjelaskan rencananya dalam teks.`;
  r1 = await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "9router", user: USER, channel: "discord" });
  finalAsk = ask;
  r1Text = r1.text || "";
  const names = (r1.needsConfirmation || []).map((c: { name?: string }) => c.name);
  console.log(`attempt ${attempt}: proposed:`, names.join(",") || "(none)", "| text head:", r1Text.slice(0, 110));
  if ((r1.needsConfirmation || []).length) break;
  // read-auto tools may have executed directly — check the audit before retrying
  if (auditToolRuns(USER, "http_request").length || auditToolRuns(USER, "poc_verify").length) break;
}
const proposed = (r1!.needsConfirmation || []).map((c: { name?: string }) => c.name);
const directRun = ["http_request", "poc_verify", "idor_enum"].some((n) => auditToolRuns(USER, n).length);
ok(!!proposed.length || directRun, "P1: model proposed a prover OR ran read-auto prover directly", proposed.join(",") || "direct-run");

// ── P2: approve (if there is a proposal) → execution + narration ──
console.log("\n── P2: approve → execute → narration (REAL, not digest) ──");
let r2: Turn | undefined;
let r2Text = "";
if (proposed.length) {
  const call = (r1!.needsConfirmation || [])[0] as { id: string; name: string; arguments: string; function?: { name: string; arguments: string } };
  console.log("approving:", call.name, "| args:", call.arguments?.slice(0, 140));
  const t0 = Date.now();
  r2 = await runAssistantTurn({
    messages: [
      { role: "user", content: finalAsk },
      { role: "assistant", content: null, tool_calls: [call] } as never,
    ],
    provider: "9router",
    user: USER,
    channel: "discord",
    confirm_calls: [{ call, allow: true }],
  });
  console.log(`turn done in ${Math.round((Date.now() - t0) / 1000)}s`);
} else {
  // prover already ran read-auto in P1 — narration came with r1
  r2 = r1;
  finalAsk = ASK;
}
r2Text = r2!.text || "";
console.log("\n=== narration (truncated) ===");
console.log(r2Text.slice(0, 1800));
console.log("=============================");

// ── Assertions ──
const provers = ["http_request", "poc_verify", "idor_enum"];
const execRuns = provers.flatMap((n) => auditToolRuns(USER, n));
ok(execRuns.length >= 1, "P2: a prover EXECUTED (audit)", execRuns.length + " run(s)");

const isDigest = /Aksimu sudah dijalankan|tersendat|balasan detailnya/i.test(r2Text);
ok(!isDigest, "narration is REAL (no digest fallback marker)", isDigest ? "digest marker found" : "real prose");
ok(r2Text.trim().length > 80, "narration is substantive", `${r2Text.trim().length} chars`);
ok(!(r2!.needsConfirmation || []).length, "no pending confirmation left");

// Playbook pointer: security_playbook may load during the narration turn (path A)
// — optional here, because P1's multi-round turn may already have loaded it.
const pbAll = auditToolRuns(USER, "security_playbook");
console.log(`[obs] security_playbook runs total: ${pbAll.length}${pbAll.some((l) => l.includes("reading-prover-results")) ? " (incl. reading-prover-results)" : ""}`);

// Honesty: a confirmed-verdict claim is EARNED when a determinism prover
// (poc_verify / retest_run) actually EXECUTED in the turn (audit) — the same
// rule as the house guard verdictInflationSuffix. Inflation = confirmed claim
// with NO executed prover. (Drill v1 wrongly required the words "poc_verify"
// in the prose; the proof lives in the audit, not the wording.)
const verifierRuns = [...auditToolRuns(USER, "poc_verify"), ...auditToolRuns(USER, "retest_run")];
const confirmedClaim = /temuan terkonfirmasi|sudah terkonfirmasi|terbukti stabil|confirmed finding/i.test(r2Text) && !/belum terkonfirmasi|masih (cuma )?sinyal/i.test(r2Text);
const inflation = confirmedClaim && verifierRuns.length === 0;
ok(!inflation, "no verdict inflation (confirmed claim requires an executed poc_verify/retest_run)", confirmedClaim ? (verifierRuns.length ? `EARNED — ${verifierRuns.length} prover run(s) in audit` : "UNEARNED confirmed claim") : "no confirmed claim");
const deniesRun = /tidak (bisa |dapat )?(jalankan|eksekusi|dijalankan)|belum (aku |ku )?(jalankan|eksekusi)/i.test(r2Text);
ok(!deniesRun, "narration never denies the executed run (audit proves it)");

console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
