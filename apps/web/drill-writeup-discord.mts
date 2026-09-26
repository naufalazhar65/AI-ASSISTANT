// LIVE drill (production path, 9router = DISCORD_PROVIDER) — does the `writeup`
// tool actually work through chat?
//
// Owner ask (2026-09-26): "Jalankan drill Discord untuk memastikan tool writeup
// tetap jalan lewat chat".
//
// Flow (house rules: proof = audit log + on-disk artifacts, never prose):
//   P1  seed one finding via the PRODUCTION dispatch (executeTool finding_add)
//       whose evidence carries a live credential marker — so the drill also
//       proves the §8 writeup redaction fires through chat.
//   P2  the Discord-path ask "buatkan writeup untuk temuan <id>" runs a REAL
//       turn (runAssistantTurn, channel discord, provider 9router).
//   P3  assertions: audit log shows tool:writeup executed; the reply carries
//       the §8 skeleton; zero credential leak in the reply; delivery matrix
//       documented (writeup is opencodego-only today — the honest gap the
//       drill exposes if it cannot run on 9router).
//
// tsx does NOT load .env.local — parse manually. Run from repo root:
//   npx tsx apps/web/drill-writeup-discord.mts
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn, toolsForUrl } = await import("./src/lib/agent");

const USER = `verify_wudrill_${Date.now()}`;
const SECRET = "K0h0na_Sup3rAdmin!";
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

async function turnWithRetry(args: Parameters<typeof runAssistantTurn>[0], tries = 3): Promise<Awaited<ReturnType<typeof runAssistantTurn>>> {
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return (await runAssistantTurn(args)) as Awaited<ReturnType<typeof runAssistantTurn>>;
    } catch (e) {
      lastErr = e;
      console.log(`[retry] attempt ${i} failed: ${(e as Error).message?.slice(0, 120)}`);
      if (i < tries) await new Promise((r) => setTimeout(r, 30000));
    }
  }
  throw lastErr;
}

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

// ── P0: delivery matrix (documented, not assumed) ──
console.log("── P0: writeup delivery matrix (runtime) ──");
const windows: [string, string][] = [
  ["9router-64 (Discord prod)", "http://127.0.0.1:20128/v1/chat/completions"],
  ["groq-128", "https://api.groq.com/openai/v1/chat/completions"],
  ["openrouter-128", "https://openrouter.ai/api/v1/chat/completions"],
  ["opencodego-uncapped", "https://opencode.ai/zen/go/v1/chat/completions"],
];
let prodDelivery = false;
for (const [label, url] of windows) {
  const has = toolsForUrl(url).some((t: { function: { name: string } }) => t.function.name === "writeup");
  if (label.startsWith("9router")) prodDelivery = has;
  console.log(`   ${label}: writeup delivered=${has}`);
}

// ── P1: seed a finding via the production tool dispatch ──
console.log("\n── P1: seed finding via executeTool (production dispatch) ──");
const { executeTool } = await import("./src/lib/tools");
const addOut = await executeTool({
  id: "t1",
  name: "finding_add",
  arguments: JSON.stringify({
    title: "IDOR on /api/cek-nik exposes citizen PII",
    severity: "high",
    cvss: 8.2,
    cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
    owasp: "A01:2025",
    cwe: "CWE-639",
    target: `${LAB}/api/cek-nik`,
    steps: `1. GET /api/cek-nik?id=1 (no auth)\n2. Change id=2 → another citizen returned\n3. Login admin / ${SECRET} to compare admin view`,
    evidence: "GET /api/cek-nik?id=2 → 200 {\"nik\":\"3204010101800001\",\"nama\":\"Budi\"}; login {\"password\":\"" + SECRET + "\"} accepted",
    impact: "Full PII read of every citizen record without authentication.",
    root_cause: "Object id trusted from the request without an ownership/authorization check.",
    remediation: "Enforce server-side object-level authorization on every read.",
  }),
}, USER);
console.log("finding_add:", addOut.slice(0, 110).replace(/\n/g, " | "));
ok(!addOut.startsWith("Error:"), "P1: finding_add accepted via production dispatch");
const idMatch = addOut.match(/F-[0-9a-z]+(?:-[0-9a-z]+)?/i);
const FID = idMatch ? idMatch[0] : "";
ok(!!FID, "P1: finding id parseable", FID);

// ── P2: the Discord-path writeup ask (REAL turn, 9router) ──
console.log("\n── P2: Discord-path writeup ask (9router) ──");
const ask = `buatkan writeup untuk temuan ${FID}`;
let r1 = (await turnWithRetry({ messages: [{ role: "user", content: ask }], provider: "9router", user: USER, channel: "discord" })) as Awaited<ReturnType<typeof runAssistantTurn>>;
let r1Text = r1.text || "";
if ((r1.needsConfirmation || []).length) {
  const calls = (r1.needsConfirmation || []).slice(0, 2);
  r1 = (await turnWithRetry({
    messages: [{ role: "user", content: ask }, { role: "assistant", content: r1Text, tool_calls: calls } as never],
    provider: "9router", user: USER, channel: "discord",
    confirm_calls: calls.map((c: { id: string; name: string; arguments: string }) => ({ call: c, allow: true })),
  })) as Awaited<ReturnType<typeof runAssistantTurn>>;
  r1Text = r1.text || "";
}
console.log("reply head:", r1Text.slice(0, 220).replace(/\n/g, " | "));

// ── P3: assertions ──
console.log("\n── P3: assertions ──");
const wuRuns = auditToolRuns(USER, "writeup");
ok(wuRuns.length >= 1, "P3: audit log shows tool:writeup EXECUTED", `${wuRuns.length} run(s)`);

if (prodDelivery && wuRuns.length) {
  ok(/Suggested:/i.test(r1Text), "P3: reply carries the §8 suggested-severity line");
  ok(!r1Text.includes(SECRET), "P3: zero credential leak in the chat reply");
} else {
  // The honest path: the model must NOT have claimed a writeup it could not run,
  // and must not have leaked the seeded credential either.
  ok(!/sudah (aku )?(buat|kumpul|siapkan)[^.]{0,40}writeup/i.test(r1Text) || wuRuns.length >= 1,
    "P3: no false 'writeup done' claim without audit evidence");
  ok(!r1Text.includes(SECRET), "P3: zero credential leak in the chat reply (fallback path)");
}
ok(!r1Text.includes("K0h0na"), "P3: admin password prefix never reaches chat");

console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
