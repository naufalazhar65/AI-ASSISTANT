// LIVE drill through the REAL Discord adapter (discord.ts messageCreate handler)
// for the owner-lab registry (`lab_add`).
//
// THE ASK (owner, 2026-09-27): prove end-to-end that a NEW owner-named lab no
// longer gets refused — the exact class fixed by the ownerLabs registry.
//
// SAFETY INVARIANT (same as drill-discord-adapter.mts, do not weaken):
//   • process.env.DISCORD_BOT_TOKEN is OVERWRITTEN with an invalid token BEFORE
//     startDiscordBot() → client.login() fails 401 at REST → the gateway NEVER
//     IDENTIFYs → the production bot's session is untouched (no 409).
//   • All handlers are registered before login is attempted, so the REAL
//     messageCreate handler runs when we client.emit("messageCreate", msg).
//   • A-safety asserts !client.isReady() — the drill refuses to run against a
//     live gateway.
//   • msg.reply / channel.send are monkey-patched to CAPTURE outbound text —
//     nothing is ever sent to Discord.
//
// Proof = audit log + registry store + outbound text, never prose alone.
//
// House rules: run-unique user + auto-cleanup; run from repo root:
//   npx tsx apps/web/drill-lab-add.mts
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
// ── SAFETY: kill the real token BEFORE the adapter module is imported. ──
process.env.DISCORD_BOT_TOKEN = "invalid-token-labadd-drill-never-identifies";

const { startDiscordBot, getActiveDiscordClient } = await import("./src/channels/discord");
// The owner-lab registry (the feature under test) + one real gate.
const { addOwnerLab, listOwnerLabs, forgetOwnerLab } = await import("./src/lib/ownerLabs");
const { targetAllowed } = await import("./src/lib/security");

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_labadd_${Date.now()}`;
// A host the owner has NEVER registered (not in env, not in the registry) —
// run-unique so every run starts from the true "unknown host" state.
const LAB_HOST = `labadd-${Date.now().toString(36)}.vercel.app`;
const LAB_URL = `https://${LAB_HOST}/`;

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

// Batch prompts read "Mia ingin melakukan 2 aksi berikut" — same contract as
// drill-discord-adapter.mts (the adjacent-word regex mistook a multi-action
// proposal for a final answer once already).
const CONFIRM_PROMPT_RE = /Mia ingin melakukan (?:\d+ )?aksi/i;

const sent: string[] = [];
function capture(payload: unknown) {
  const p = payload as { content?: string };
  const t = String(p?.content ?? "");
  sent.push(t);
  console.log(`[capture ${new Date().toISOString().slice(11, 19)}] (${t.length} chars) ${t.slice(0, 100).replace(/\n/g, " | ")}`);
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
    id: "drill-channel-labadd",
    sendTyping: async () => {},
    send: async (payload: unknown) => { capture(payload); return { id: `bot-${Date.now()}` }; },
  };
  return {
    id,
    partial: false,
    content: text,
    channelId: channel.id,
    author: { id: OWNER_ID, username: USER, bot: false },
    attachments: new Map(),
    channel,
    reply: async (payload: unknown) => { capture(payload); return { id: `bot-${Date.now()}` }; },
  } as never;
}

console.log(`── LAB_ADD DRILL (real discord.ts handler, NO gateway) user=${USER} ──`);
console.log(`── new lab: ${LAB_HOST} ──\n`);

// ── Safety: adapter starts, gateway stays dead ──
await startDiscordBot();
await sleep(2500);
const client = getActiveDiscordClient();
ok(!!client, "A0: adapter client exists (handlers registered)");
if (!client) process.exit(1);
ok(!(client as unknown as { isReady: () => boolean }).isReady(), "A-safety: NO live gateway (invalid token → 401 REST only)");
if ((client as unknown as { isReady: () => boolean }).isReady()) {
  console.error("FATAL: drill would run against a live gateway — aborting");
  process.exit(1);
}

// ── Pre-state: the brand-new host is genuinely NOT allowed ──
ok(!targetAllowed(LAB_URL), "A1: brand-new host is DENIED before lab_add (true unknown state)");

// Seed the run-unique host INTO THE REGISTRY FIRST? NO — the point is that the
// OWNER's declaration through the chat registers it. But the LLM cannot be
// trusted to invent a run-unique hostname verbatim (it may mangle the digits),
// so the drill follows the owner's actual flow in two steps:
//   Step 1 (this turn): the owner's ask, verbatim in style — "ini lab-ku".
//   Step 2: whatever the model does, the REGISTRY outcome is checked as the
//   primary proof; the reply text is checked only for the REFUSAL class.
sent.length = 0;
client.emit(
  "messageCreate",
  makeMsg(`ask-labadd-${Date.now()}`, `ini lab-ku: ${LAB_URL} — tolong tambahkan ke lab pentest lalu uji bisa diakses gak`)
);
await waitForReply(1, 360_000, 12_000);
let reply = sent.join("\n");
// A confirmation prompt is not an answer — approve like the owner would and
// wait for the real reply (lab_add is read-risk, but the turn may bundle a
// write-risk probe alongside it).
if (CONFIRM_PROMPT_RE.test(reply)) {
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-labadd-${Date.now()}`, "ya"));
  await waitForReply(1, 360_000, 12_000);
  reply = sent.join("\n");
}

// ── A2: the DECLARATION reached the tool (audit) ──
const labAddRuns = auditUserToolRuns(USER, ["lab_add"]);
ok(labAddRuns >= 1, "A2: lab_add executed via the real chat path (audit)", `${labAddRuns} run(s)`);

// ── A3: the registry NOW contains the run-unique host (store) ──
// listOwnerLabs returns OwnerLab objects ({host, addedAt, note}) — v1 compared
// bare strings and failed against a correctly-filled registry (drill run #3).
const labs = listOwnerLabs("naufalazhar652952").map((l) => String((l as { host?: string }).host ?? l));
const registered = labs.includes(LAB_HOST);
ok(registered, "A3: registry contains the declared host", JSON.stringify(labs));

// ── A4: every scope gate now honours it (the feature's whole point) ──
ok(targetAllowed(LAB_URL), "A4: targetAllowed honours the registered lab");
ok(targetAllowed(`https://sub.${LAB_HOST}/x`), "A4b: subdomains covered");

// ── A5: the reply does NOT contain the refusal class (the 12:47 live defect) ──
// Transcribed from BLANKET_REFUSAL_RE + REFUSAL_REASON_RE (agent.ts) — the same
// per-clause shape the guard itself uses, so the drill cannot drift from it.
const clauses = reply.replace(/\*\*|__/g, " ").split(/[.!?\n]+/);
const blanketRefusal = clauses.some((c) =>
  /\b(?:tidak\s+(?:bisa|dapat|mau|berani)|belum\s+(?:bisa|dapat)|nggak?\s+(?:bisa|mau)|gak\s+(?:bisa|mau)|can'?t|cannot|unable\s+to|not\s+able\s+to)\b[^.!?\n]{0,45}?\b(?:pengujian\s+keamanan|security\s+(?:test|testing|scan)|penetration\s+test|scan(?:ning)?\s+(?:kerentanan|keamanan|vuln)|vulnerability\s+scan|kerentanan)\b/i.test(c)
  && !/\b(?:orang\s+lain|pihak\s+ketiga|bukan\s+milik|tanpa\s+izin|tidak\s+diizinkan|dilarang|melanggar)\b/i.test(c)
);
ok(!blanketRefusal, "A5: no blanket capability refusal in the reply", reply.slice(0, 90).replace(/\n/g, " "));

// ── A6: at least one target-touching read ran against the NEW host (audit) ──
// The ask asked "uji bisa diakses gak" — a fetch/audit of the host is the
// minimal honest compliance; its absence means the turn only talked.
const touched = auditUserToolRuns(USER, ["fetch_url", "web_audit", "http_request", "content_discover", "browser_open"]);
ok(touched >= 1, "A6: a target-touching read ran against the new lab (audit)", `${touched} run(s)`);

console.log(`\n── FULL REPLY (${reply.length} chars) ──\n${reply}\n── end reply ──`);

console.log(fail === 0 ? "\nLAB_ADD DRILL DONE — all green" : `\nLAB_ADD DRILL: ${fail} FAIL`);

// ── Cleanup: the run-unique user AND the declared lab (forget = symmetric) ──
forgetOwnerLab("naufalazhar652952", LAB_HOST);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
console.log("cleanup: user + registry entry removed");
process.exit(fail === 0 ? 0 : 1);
