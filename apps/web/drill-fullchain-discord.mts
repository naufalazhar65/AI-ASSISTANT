// LIVE drill (production path) — exploit_chain with the batch-2 chains via a
// REAL LLM turn, Discord contract (runAssistantTurn + confirm_calls), audit-log
// proof (house rule: proof = audit log, not prose).
//
// Owner ask: "full pentest 12 chain ke lab Kohona lewat Discord".
// The FULL 12-chain list includes auth/IDOR chains that need sessions (idor,
// auth_bypass, session_fixation) — the honest path: propose them anyway, approve,
// and the chain runner SKIPS what lacks setup with the ⛔ marker (honest-skip is
// the designed behavior). The batch-2 chains (cache_decep, nosql) need nothing.
//
// tsx does NOT load .env.local — parse manually (repo gotcha).
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn, toolsForUrl, CORE_TOOL_NAMES } = await import("./src/lib/agent");

const USER = `verify_fcdrill_${Date.now()}`; // run-unique: audit log is append-only/shared
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const CHAINS = "idor,ssrf,race,graphql,xxe,open_redirect,cache_poison,bypass403,otp,proto_pollute,cache_decep,nosql";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

// ── Audit-log proof helper ──
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

console.log("── P0: delivery matrix ──");
const groq = new Set(toolsForUrl("https://api.groq.com/openai/v1/chat/completions").map((t: any) => t.function.name));
const r9 = toolsForUrl("http://127.0.0.1:20128/v1/chat/completions").map((t: any) => t.function.name);
ok(CORE_TOOL_NAMES.has("exploit_chain") && groq.has("exploit_chain") && !r9.includes("exploit_chain"), "exploit_chain: CORE+groq, not on 9router-64 (by design)");
console.log("chains requested:", CHAINS);

// ── P1: PROPOSE via a real openrouter LLM turn ──
console.log("\n── P1: propose (openrouter, channel discord) ──");
const askBase = `lakukan full pentest di ${LAB} — jalankan exploit_chain dengan chain="${CHAINS}" lalu ringkas hasilnya`;
type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;
let r1: Turn | undefined;
let finalAsk = askBase;
for (let attempt = 1; attempt <= 3; attempt++) {
  const ask = attempt === 1 ? askBase : `${askBase}. PANGGIL tool exploit_chain-nya sekarang — jangan cukup menarasikan usulannya dalam teks.`;
  r1 = await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "openrouter", user: USER, channel: "discord" });
  finalAsk = ask;
  const names = (r1.needsConfirmation || []).map((c: any) => c.name);
  console.log(`attempt ${attempt}: proposed:`, names.join(",") || "(none)", "| text head:", (r1.text || "").slice(0, 120));
  if (names.includes("exploit_chain")) break;
}
const proposed = (r1!.needsConfirmation || []).map((c: any) => c.name);
ok(proposed.includes("exploit_chain"), "P1: model proposed exploit_chain (needsConfirmation)", proposed.join(",") || "none");
ok(auditToolRuns(USER, "exploit_chain").length === 0, "P1: zero execution before approval (audit)");
const call = (r1!.needsConfirmation || []).find((c: any) => c.name === "exploit_chain");
if (!call) throw new Error("P1: no exploit_chain proposal after 3 attempts");
console.log("P1 proposed args (trunc):", JSON.stringify(call).slice(0, 260));

// ── P2: APPROVE → real execution of the 12-chain batch ──
console.log("\n── P2: approve → execute (audit = proof) ──");
const t0 = Date.now();
const r2 = await runAssistantTurn({
  messages: [
    { role: "user", content: finalAsk },
    { role: "assistant", content: null, tool_calls: [call] },
  ],
  provider: "openrouter",
  user: USER,
  channel: "discord",
  confirm_calls: [{ call, allow: true }],
});
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`turn done in ${secs}s`);
console.log("\n=== P2 turn output (truncated) ===");
console.log((r2.text || "").slice(0, 2200));
console.log("==================================");

// ── Assertions ──
const runs = auditToolRuns(USER, "exploit_chain");
ok(runs.length >= 1, "P2: audit tool:exploit_chain EXECUTED", `${runs.length} run(s)`);
ok(!(r2.needsConfirmation || []).length, "P2: no pending confirmation left");
ok(!/REFUSED|not delivered|not available on this provider/i.test(r2.text || ""), "P2: no delivery-guard refusal");

// Chain-run evidence: the reply may be EITHER a real narration OR the honest
// digest fallback (Nex AGI 400 transient — allowed by the house contract). When
// the prose is a digest, prove the chains from STORAGE instead: http-history
// records the real requests the chains fired at the lab.
const out = r2.text || "";
const isDigest = /Aksimu sudah dijalankan|tersendat/i.test(out);
let chainEvidence = "";
if (/EXPLOIT CHAIN/.test(out) && /Ringkasan/.test(out)) {
  const summ = out.split("Ringkasan").slice(1).join("Ringkasan");
  const ran = /(\d+) chain dengan langkah nyata/.exec(summ);
  chainEvidence = `prose summary: ${ran ? ran[1] : "?"} chains with real steps`;
  ok(!!ran && Number(ran[1]) >= 5, "≥5 chains ran with real steps (rest honest-skip)", chainEvidence);
} else if (isDigest) {
  // storage-backed proof: chains' real HTTP hits to the lab
  const histPath = join(process.cwd(), "apps/web/.data/users", USER, "http-history.json");
  let hist: Array<{ url: string; method: string; status: number }> = [];
  try { hist = JSON.parse(readFileSync(histPath, "utf8")); } catch { /* none */ }
  const urls = hist.map((h) => h.url);
  console.log(`http-history: ${hist.length} requests to the lab`);
  for (const l of urls.slice(0, 10)) console.log("  ·", l.slice(0, 110));
  const decep = urls.some((u) => /account(\.css|\/test\.css|%23test\.css|;test\.css)/i.test(u));
  const methodCount = hist.reduce<Record<string, number>>((m, h) => { m[h.method] = (m[h.method] || 0) + 1; return m; }, {});
  console.log("methods:", JSON.stringify(methodCount));
  // The chains get the BASE url (the model would pass specific endpoints in a
  // real ask) — so the nosql POST volley lands on the base URL. Contract: the
  // POST volley happened (nosql/otp are the POSTers), not a specific path.
  const posts = hist.filter((h) => h.method === "POST").length;
  ok(decep, "cache_decep decoy requests visible in http-history");
  ok(posts >= 4, "nosql/otp POST volley visible in http-history", `${posts} POSTs`);
  ok(hist.length >= 10, "chain batch fired a real request volley at the lab", `${hist.length} records`);
} else {
  ok(false, "reply neither narrates chains nor honest digest", out.slice(0, 120));
}
// honesty: skipped chains carry the skip marker, never "all confirmed"
const deniesSkip = /semua chain (terkonfirmasi|berhasil)/i.test(out);
ok(!deniesSkip, "output never claims all chains confirmed");
const deniesRun = /tidak (bisa |dapat )?(jalankan|eksekusi|dijalankan)|belum (aku |ku )?(jalankan|eksekusi)/i.test(out);
ok(!deniesRun, "narration never denies the executed run (audit proves it)");

console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
