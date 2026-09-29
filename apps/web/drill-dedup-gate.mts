// LIVE drill — dedup gate (precision #4) through the REAL tool dispatch path
// (executeTool, the path the agent uses) and the REAL Discord adapter.
//
// Proof = toy-server request counter + hunt store + audit log, NEVER prose.
//
// SAFETY INVARIANT (drill-lab-add / drill-discord-adapter, do not weaken):
//   • process.env.DISCORD_BOT_TOKEN is OVERWRITTEN invalid BEFORE the adapter
//     import → login 401 at REST → the gateway NEVER IDENTIFYs → no 409 vs the
//     production bot; !client.isReady() refuses to run against a live gateway.
//   • msg.reply / channel.send are monkey-patched — nothing reaches Discord.
//
// PROVIDER NOTE: exploit_chain is NOT delivered on the 9router-64 window (by
// design since 2026-09-21), so the P1 chat turn runs on `openrouter` (full
// CORE window) via DISCORD_PROVIDER — same pattern as drill-fullchain.
//
// House rules: run-unique user + auto-cleanup; run from repo root:
//   npx tsx apps/web/drill-dedup-gate.mts
import { readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
// ── SAFETY: kill the real token BEFORE the adapter module is imported. ──
process.env.DISCORD_BOT_TOKEN = "invalid-token-dedup-drill-never-identifies";
// Full-window provider for the P1 turn (exploit_chain must be DELIVERED).
process.env.DISCORD_PROVIDER = "openrouter";

const { startDiscordBot, getActiveDiscordClient } = await import("./src/channels/discord");
const { executeTool } = await import("./src/lib/tools");
const { huntSet, readHunt, normalizeTarget } = await import("./src/lib/huntLog");

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_dedup_${Date.now()}`;

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function auditUserToolRuns(user: string, names: string[]): number {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return 0;
  let hits = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l.includes(`"user":"${user}"`) || !l.includes('"action":"tool:')) continue;
      if (names.some((n) => l.includes(`"action":"tool:${n}"`))) hits++;
    }
  }
  return hits;
}

/** Remove THIS drill's toy entries from the shared hunt store (hygiene). */
function cleanSharedHunt(port: number) {
  try {
    const p = join(process.cwd(), "apps/web/.data/users/shared/hunt-state.json");
    if (!existsSync(p)) return;
    const rows = JSON.parse(readFileSync(p, "utf8")) as Array<{ target: string }>;
    const kept = rows.filter((r) => !r.target?.startsWith(`127.0.0.1:${port}`));
    if (kept.length !== rows.length) writeFileSync(p, JSON.stringify(kept, null, 2));
  } catch { /* best-effort */ }
}

// ── Toy target: an /admin 403 that bypasses via X-Original-URL ──
let adminHits = 0;
const toy = http.createServer((req, res) => {
  const u = req.url || "/";
  if (req.headers["x-original-url"] === "/admin" || u.startsWith("//admin")) {
    adminHits++; res.writeHead(200); res.end("ADMIN PANEL secret"); return;
  }
  if (u === "/admin") { adminHits++; res.writeHead(403); res.end("403 deny id 12345678"); return; }
  res.writeHead(404); res.end("nope");
});
await new Promise<void>((r) => toy.listen(0, "127.0.0.1", () => r()));
const PORT = (toy.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `${BASE}/admin`;
const ADMIN_KEY = normalizeTarget(ADMIN); // hunt_log stores targets SCHEME-LESS

console.log(`── DEDUP GATE DRILL user=${USER} target=${ADMIN} ──\n`);

// ══ P0: gate mechanics through the REAL dispatch path (executeTool + rawUser) ══
// P0.1: first run → prover fires (~20 requests) → recorder marks LEAD.
const r1 = await executeTool({ id: "d1", name: "exploit_chain", arguments: JSON.stringify({ chain: "bypass403", url: ADMIN }) }, USER);
ok(r1.includes("BYPASS LEAD"), "P0.1: first dispatch carries the BYPASS LEAD", r1.slice(0, 80).replace(/\n/g, " "));
ok(adminHits >= 10, "P0.1b: the prover really fired (toy counter)", `${adminHits} hits`);
const lead = readHunt(USER).find((e) => e.target === ADMIN_KEY);
ok(!!lead && lead.status === "lead", "P0.1c: recorder wrote hunt_log LEAD (user store)", JSON.stringify(lead?.note || "").slice(0, 90));

// P0.2: second run on the same target → runs (lead never gates) + dedup context note.
adminHits = 0;
const r2 = await executeTool({ id: "d2", name: "exploit_chain", arguments: JSON.stringify({ chain: "bypass403", url: ADMIN }) }, USER);
ok(r2.includes("BYPASS LEAD"), "P0.2: lead does NOT gate the run");
ok(r2.includes("Konteks dedup") && r2.includes("hunt_log: LEAD"), "P0.2b: dedup context note names the recorded lead");
ok(adminHits >= 10, "P0.2c: run really happened again", `${adminHits} hits`);

// P0.3: mark DEAD → third run is an honest skip with ZERO new requests.
await huntSet(USER, ADMIN, "dead", "drill: simulate a previous no-signal verdict");
adminHits = 0;
const r3 = await executeTool({ id: "d3", name: "exploit_chain", arguments: JSON.stringify({ chain: "bypass403", url: ADMIN }) }, USER);
ok(r3.includes("⛔ CHAIN TIDAK DIJALANKAN") && r3.includes("DEAD"), "P0.3: dead target → honest skip marker");
ok(r3.includes("0 langkah dijalankan"), "P0.3b: skip reports 0 steps");
ok(adminHits === 0, "P0.3c: ZERO requests passed the gate (counter = ground truth)", `${adminHits} hits`);

// P0.4: a DIFFERENT chain to the same dead target also skips (gate is per-target).
const r4 = await executeTool({ id: "d4", name: "exploit_chain", arguments: JSON.stringify({ chain: "otp", url: ADMIN }) }, USER);
ok(r4.includes("⛔ CHAIN TIDAK DIJALANKAN") && r4.includes("DEAD"), "P0.4: gate is per-target (other chains skip too)");

console.log("");

// ══ P1: the REAL Discord adapter LLM turn reaches the gated tool ══
const CONFIRM_PROMPT_RE = /Mia ingin melakukan (?:\d+ )?aksi/i;
const sent: string[] = [];
function capture(payload: unknown) {
  const p = payload as { content?: string };
  const t = String(p?.content ?? "");
  sent.push(t);
  console.log(`[capture ${new Date().toISOString().slice(11, 19)}] (${t.length} chars) ${t.slice(0, 90).replace(/\n/g, " | ")}`);
}
async function waitForReply(minCapture = 1, maxMs = 300_000, stableMs = 9000): Promise<void> {
  const start = Date.now();
  while (sent.length < minCapture) {
    if (Date.now() - start > maxMs) return;
    await sleep(750);
  }
  let stableSince = Date.now();
  let lastN = sent.length;
  while (Date.now() - start < maxMs) {
    await sleep(500);
    if (sent.length !== lastN) { lastN = sent.length; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= stableMs) return;
  }
}
function makeMsg(id: string, text: string) {
  const channel: Record<string, unknown> = {
    id: "drill-channel-dedup",
    sendTyping: async () => {},
    send: async (payload: unknown) => { capture(payload); return { id: `bot-${Date.now()}` }; },
  };
  return {
    id, partial: false, content: text, channelId: channel.id,
    author: { id: OWNER_ID, username: USER, bot: false },
    attachments: new Map(), channel,
    reply: async (payload: unknown) => { capture(payload); return { id: `bot-${Date.now()}` }; },
  } as never;
}

await startDiscordBot();
await sleep(2500);
const client = getActiveDiscordClient();
ok(!!client, "P1-A0: adapter client exists (handlers registered)");
if (!client) process.exit(1);
ok(!(client as unknown as { isReady: () => boolean }).isReady(), "P1-safety: NO live gateway (invalid token → 401 REST only)");
if ((client as unknown as { isReady: () => boolean }).isReady()) { console.error("FATAL: live gateway — aborting"); process.exit(1); }

// The P0 drill left the target DEAD — mirror the owner flow "target berubah /
// mau diulang": the gate honors a re-opened status (dead → lead) and the chat
// run then really executes and re-records.
await huntSet(USER, ADMIN, "lead", "drill: owner re-opens the dead target");

sent.length = 0;
client.emit("messageCreate", makeMsg(`ask-dedup-${Date.now()}`, `uji bypass 403 di ${ADMIN} pakai exploit_chain chain=bypass403`));
await waitForReply(1, 360_000, 12_000);
let reply = sent.join("\n");
if (CONFIRM_PROMPT_RE.test(reply)) {
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-dedup-${Date.now()}`, "ya"));
  await waitForReply(1, 360_000, 12_000);
  reply = sent.join("\n");
}

const chainRuns = auditUserToolRuns(USER, ["exploit_chain"]);
ok(chainRuns >= 1, "P1-A1: exploit_chain executed via the real chat path (audit)", `${chainRuns} run(s)`);
const p1Lead = readHunt(USER).find((e) => e.target === ADMIN_KEY);
ok(!!p1Lead && p1Lead.status === "lead" && /bypass403/.test(p1Lead.note || ""), "P1-A2: the chat-path run re-recorded the LEAD (store)", JSON.stringify(p1Lead?.note || "").slice(0, 90));
ok(reply.length > 0, "P1-A3: the owner got a reply", reply.slice(0, 80).replace(/\n/g, " "));

console.log(fail === 0 ? "\nDEDUP GATE DRILL DONE — all green" : `\nDEDUP GATE DRILL: ${fail} FAIL`);

toy.close();
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
cleanSharedHunt(PORT);
console.log("cleanup: user store removed, shared hunt entries pruned, toy closed");
