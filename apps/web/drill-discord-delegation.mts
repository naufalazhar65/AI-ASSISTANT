// LIVE drill for the 2026-10-12 Discord bot-to-bot delegation fix.
//
// WHAT IS BEING PROVEN (this is the bug the owner reported):
//   Michelle answered the owner with a plain-text hand-off —
//   "Agnes, tolong dicarikan berita yang lagi viral saat ini ya." — and Agnes
//   never replied. Root cause: discord.ts opened messageCreate with
//   `if (!msg.author || msg.author.bot) return;`, so EVERY bot-authored message
//   was dropped before trio routing, before alreadyProcessed, and before any log
//   line. The failure was 100% silent.
//
// SAFETY INVARIANT (unchanged from drill-discord-adapter.mts):
//   • All trio tokens are OVERWRITTEN with invalid values BEFORE the adapter
//     module is imported -> login() 401s at the REST layer -> the gateway never
//     IDENTIFYs -> the production bot's session is untouched (a second live
//     Identify is what causes 409 Conflict on the real bot).
//   • A0 asserts !client.isReady() and aborts if that is ever false.
//   • msg.reply / channel.send are monkey-patched to CAPTURE outbound text.
//     Nothing is ever sent to Discord.
//
//   ClientReady never fires in this drill, so `trioBotLabels` would be empty and
//   `discordAuthorLabel()` would return null for every id — which collapses the
//   sibling path into a SELF-ECHO rejection (from === to). That would make the
//   drill prove a wiring bug production does not have. `__seedDiscordBotIdentity`
//   (a drill-only hook, same family as `__resetSlackTurnGuard` and
//   `getActiveDiscordClient`) registers synthetic trio identities so the real
//   code path runs unchanged.
//
// House rules: run-unique user; proof = captured adapter replies + logs, never
// the model's prose. Run from repo root:
//   npx tsx apps/web/drill-discord-delegation.mts
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
// ── SAFETY: kill every real token BEFORE the adapter module is imported. ──
const FAKE = "invalid-token-delegation-drill-never-identifies";
for (const k of ["DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN_AGNES", "DISCORD_BOT_TOKEN_MICHELLE"]) {
  if (process.env[k]) process.env[k] = FAKE;
}

const {
  startDiscordBot,
  getDiscordClient,
  __seedDiscordBotIdentity,
} = await import("./src/channels/discord");

// `[discord] turn failed:` prints err.message only, which hides WHERE a harness
// gap lives. Promote any Error to its full stack so a synthetic-message defect
// is diagnosable instead of guessed at.
const realError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  const err = args.find((a) => a instanceof Error) as Error | undefined;
  if (err) realError(first, err.stack || err.message);
  else realError(...args);
};

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_delegation_${Date.now()}`;
// The adapter's CHANNEL allow-list (`if (!isAllowedChannel(...)) return;`,
// discord.ts:793) runs for bots exactly as it does for humans, so the drill has
// to post into a real allow-listed channel. Using a synthetic channel id made
// every assertion vacuously "pass" in drill run #1 — P4/P5 looked green purely
// because the gate swallowed the message before routing. Abort instead of
// reporting a false green.
const CHANNEL = (process.env.DISCORD_ALLOWED_CHANNEL_ID || "").trim();
if (!CHANNEL) {
  console.error("FATAL: DISCORD_ALLOWED_CHANNEL_ID is not set — routing assertions would be vacuous");
  process.exit(1);
}
const SYNTH: Record<string, string> = {
  mia: "900000000000000001",
  agnes: "900000000000000002",
  michelle: "900000000000000003",
};

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Captured outbound replies, tagged with the agent whose client sent them. */
const sent: Array<{ agent: string; text: string }> = [];

function makeMsg(agent: string, id: string, text: string, opts: { authorBot?: boolean; authorId?: string; reply?: boolean } = {}) {
  const client = getDiscordClient(agent as never)!;
  const capture = (payload: unknown) => {
    // discord.js accepts BOTH a plain string and `{ content }` / `{ files }`.
    // Drill run #3 read `payload.content` off a string, got undefined, and every
    // reply counted as "" — which is exactly how the handler's error path
    // ("Maaf, ada kendala internal") made the assertions pass vacuously.
    const text = typeof payload === "string" ? payload : String((payload as { content?: string })?.content ?? "");
    sent.push({ agent, text });
    return { id: `bot-${Date.now()}` };
  };
  const channel: Record<string, unknown> = {
    id: CHANNEL,
    sendTyping: async () => {},
    send: async (payload: unknown) => capture(payload),
  };
  const msg: Record<string, unknown> = {
    id,
    partial: false,
    content: text,
    channelId: CHANNEL,
    author: {
      id: opts.authorId ?? OWNER_ID,
      username: opts.authorBot ? `drill_${agent}` : USER,
      bot: !!opts.authorBot,
    },
    attachments: new Map(),
    // Real discord.js always supplies `mentions`; without it trioMentionFlags
    // threw on `.roles` and EVERY message died in the handler catch (drill run
    // #2 found this — a harness gap, not a product bug, but it silently turned
    // every routing assertion into a no-op).
    mentions: { has: () => false, users: new Map(), roles: new Map(), channels: new Map(), everyone: false },
    guildId: "drill-guild-0001",
    channel,
    reply: async (payload: unknown) => capture(payload),
  };
  // A threaded reply (what Discord puts on a bot's answer when it replies to a
  // message) is what makes a bot message spend the hop budget instead of
  // starting a fresh chain — see slackTurnGuard's `initiatesChain`.
  if (opts.reply) msg.messageReference = { messageId: "900000000000000000" };
  void client;
  return msg as never;
}

async function waitForReply(minCapture: number, maxMs = 240_000, stableMs = 9000) {
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

/** Wait until no reply has been captured for `quietMs` — a turn that is still
 *  streaming would otherwise be counted against the NEXT assertion's baseline
 *  and turn "Mia stayed silent" into a false failure (drill run #2). */
async function drain(quietMs = 12000, maxMs = 180_000) {
  const start = Date.now();
  let last = sent.length;
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(700);
    if (sent.length !== last) { last = sent.length; stableSince = Date.now(); continue; }
    if (Date.now() - stableSince >= quietMs) return;
  }
}

const countFor = (agent: string) => sent.filter((s) => s.agent === agent).length;

console.log(`── DISCORD DELEGATION DRILL (real messageCreate, NO gateway) user=${USER} ──\n`);

await startDiscordBot();
await sleep(2500);

const mia = getDiscordClient("mia");
ok(!!mia, "A0: adapter clients exist (handlers registered)");
if (!mia) process.exit(1);
const isReady = (c: unknown) => (c as { isReady: () => boolean }).isReady();
ok(!isReady(mia), "A0-safety: NO live gateway (invalid tokens → 401 REST only)");
if (isReady(mia)) {
  console.error("FATAL: drill would run against a live gateway — aborting to protect the production session");
  process.exit(1);
}
ok(!!getDiscordClient("agnes") && !!getDiscordClient("michelle"), "A0: all three trio clients registered", "trio mode");
__seedDiscordBotIdentity(SYNTH.mia, "mia");
__seedDiscordBotIdentity(SYNTH.agnes, "agnes");
__seedDiscordBotIdentity(SYNTH.michelle, "michelle");
console.log(`   seeded trio identities: ${JSON.stringify(SYNTH)}\n`);

// ── P1 CONTROL: a normal owner message must still reach Mia. Without this,
// "silent" in P4/P5 could mean the handler is dead rather than routing-correct.
mia.emit("messageCreate", makeMsg("mia", "p1-owner", "halo, ini drill delegasi. Balasan singkat saja ya."));
await waitForReply(1);
ok((sent[0]?.text ?? "").trim().length > 0, "P1 control: owner message still answered by Mia", `"${(sent[0]?.text ?? "").slice(0, 70)}"`);
console.log("");

// ── P2 SELF-ECHO: a bot must never process its own message.
const beforeEcho = sent.length;
getDiscordClient("agnes")!.emit("messageCreate", makeMsg("agnes", "p2-self", "agnes_dim, percobaan echo.", { authorBot: true, authorId: SYNTH.agnes }));
await sleep(4000);
ok(sent.length === beforeEcho, "P2 self-echo: own message ignored, no reply");

// ── P3 THE FIX: Michelle's hand-off text reaches Agnes (the reported bug).
const handoff = "Agnes, tolong dicarikan berita yang lagi viral saat ini ya.";
getDiscordClient("agnes")!.emit("messageCreate", makeMsg("agnes", "p3-handoff", handoff, { authorBot: true, authorId: SYNTH.michelle }));
await waitForReply(beforeEcho + 1);
const p3 = sent.slice(beforeEcho).filter((s) => s.agent === "agnes");
ok(p3.length >= 1, "P3 delegation: Agnes ANSWERS Michelle's hand-off", `len=${p3[0]?.text.length ?? 0}`);
ok(!!p3[0]?.text && !/Mas Naufal/.test(p3[0].text), "P3 peer turn: Agnes addresses Michelle, not the owner", `"${(p3[0]?.text ?? "").slice(0, 70)}"`);

// ── P4 ROUTING ────────────────────────────────────────────────────────────
// P4a is the POSITIVE control that makes P4b/P4c non-vacuous: identical in
// every respect (same channel, same bot author, same message shape) except the
// addressed name. If Mia answers "Mia, ..." but stays silent for "Agnes, ...",
// the silence is routing, not a swallowed message.
const beforeMiaControl = countFor("mia");
getDiscordClient("mia")!.emit("messageCreate", makeMsg("mia", "p4a-named-mia", "Mia, tolong ringkas dong.", { authorBot: true, authorId: SYNTH.michelle }));
await waitForReply(beforeMiaControl + 1);
await drain();
ok(countFor("mia") > beforeMiaControl, "P4a control: a NAMED sibling message DOES wake Mia", "proves bot traffic reaches routing here");

const beforeMia = countFor("mia");
for (const client of ["mia", "michelle"] as const) {
  getDiscordClient(client)!.emit("messageCreate", makeMsg(client, `p4b-${client}`, handoff, { authorBot: true, authorId: SYNTH.michelle }));
}
await sleep(6000);
await drain(8000);
ok(countFor("mia") === beforeMia, "P4b routing: Mia stays out of a sibling handoff", `mia replies delta=${countFor("mia") - beforeMia}`);
const p4michelle = sent.filter((s) => s.agent === "michelle");
ok(p4michelle.length === 0, "P4c routing: the addressed-away third bot stays silent too", `michelle replies=${p4michelle.length}`);

// ── P5 LOOP GUARD: a threaded bot reply spends the hop budget (P4b/P4c left
// hops=1 on this chain); with BOT_HOP_LIMIT=1 the exchange must stop instead of
// ping-ponging forever.
const beforeHop = sent.length;
getDiscordClient("mia")!.emit("messageCreate", makeMsg("mia", "p5-hop", "Mia, ini balasan lanjutan dari Agnes.", { authorBot: true, authorId: SYNTH.agnes, reply: true }));
await sleep(6000);
ok(sent.length === beforeHop, "P5 loop guard: threaded sibling reply is bounded", `replies delta=${sent.length - beforeHop}`);

// Harness self-check: an empty capture means the drill mis-read a payload shape,
// which silently turns every assertion into a no-op (see run #3).
ok(sent.every((s) => s.text.trim().length > 0), "H0 harness: every captured reply has readable text", `${sent.filter((s) => !s.text.trim()).length} empty capture(s)`);

console.log("\n── captured replies ──");
for (const s of sent) console.log(`   [${s.agent}] ${s.text.slice(0, 110).replace(/\n/g, " ")}`);

// House rule: run-unique user dir, cleaned up so the audit log stays readable.
const dir = join(process.cwd(), "apps/web/.data/users", USER);
if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log(`\n${fail === 0 ? "ALL GREEN" : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);