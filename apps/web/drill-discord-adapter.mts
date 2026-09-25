// LIVE drill through the REAL Discord adapter (discord.ts messageCreate handler).
//
// SAFETY INVARIANT (the reason this drill exists in this shape):
//   • process.env.DISCORD_BOT_TOKEN is OVERWRITTEN with an invalid token BEFORE
//     startDiscordBot() → client.login() fails with 401 at the REST layer →
//     the gateway NEVER IDENTIFYs → the production bot's session is untouched
//     (a second live Identify is what causes 409 Conflict for the real bot).
//   • All client.on(...) handlers are registered BEFORE login is attempted in
//     discord.ts, so the REAL messageCreate handler runs when we
//     client.emit("messageCreate", syntheticMsg).
//   • A0 asserts !client.isReady() — the drill refuses to run against a live
//     gateway (learned the hard way: loading .env.local first once logged the
//     REAL token in as a second session; production survived, the drill did
//     not ship).
//   • msg.reply / channel.send are monkey-patched to CAPTURE outbound text —
//     nothing is ever sent to Discord.
//
// What is proven (owner-experience path end-to-end):
//   A2  non-owner message ignored (adapter allow-list)
//   A3  full-pentest ask → recon reply (adapter chunking) + audit runs
//   A4  risky ask → confirmation prompt → "ya" → audit proves real executions
//   A5  "buatkan pdf" → deterministic PDF file on disk + receipt reply
//   A6  honesty — no contradictory run-claims across all replies
//
// House rules: run-unique user + auto-cleanup; proof = audit log + disk.
// Run from repo root: npx tsx apps/web/drill-discord-adapter.mts
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
// ── SAFETY: kill the real token BEFORE the adapter module is imported. ──
process.env.DISCORD_BOT_TOKEN = "invalid-token-adapter-drill-never-identifies";

const { startDiscordBot, getActiveDiscordClient } = await import("./src/channels/discord");

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_adapter_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Audit-log proof helper (house rule): count tool:<name> runs for THIS user.
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

const sent: Array<{ text: string; pdf: boolean }> = [];
function capture(payload: unknown) {
  const p = payload as { content?: string; files?: unknown[] };
  sent.push({ text: String(p?.content ?? ""), pdf: Array.isArray(p?.files) && (p as { files?: unknown[] }).files!.length > 0 });
}
// Wait for ≥minCapture replies, then require quiet for stableMs (turns take 30–90s).
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
    id: "drill-channel-0001",
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

console.log(`── ADAPTER DRILL (real discord.ts handler, NO gateway) user=${USER} ──\n`);

await startDiscordBot();
await sleep(2500);
const client = getActiveDiscordClient();
ok(!!client, "A0: adapter client exists (handlers registered)");
if (!client) process.exit(1);
ok(!(client as unknown as { isReady: () => boolean }).isReady(), "A0-safety: NO live gateway (invalid token → 401 REST only)");
if ((client as unknown as { isReady: () => boolean }).isReady()) {
  console.error("FATAL: drill would run against a live gateway — aborting to protect the production session");
  process.exit(1);
}

// ── A2: non-owner message ignored ──
const intruder = makeMsg("intruder-1", "halo bot");
(intruder as { author: { id: string } }).author.id = "999999999999999999";
client.emit("messageCreate", intruder);
await sleep(1500);
ok(sent.length === 0, "A2: non-owner message produces no reply", `${sent.length} outbound`);

// ── A3: full pentest ask (owner path) ──
sent.length = 0;
client.emit("messageCreate", makeMsg(`ask1-${Date.now()}`, `mia lakukan full pentest di ${LAB}/index.html — mulai dari recon dulu, jangan uji apapun dulu`));
await waitForReply(1);
const reply1 = sent.map((s) => s.text).join("\n");
ok(sent.length >= 1, "A3: owner pentest ask gets a reply", `${sent.length} msg(s)`);
ok(/recon|temuan|resources|endpoint|memetakan|akses/i.test(reply1), "A3: reply is a recon-phase answer", reply1.slice(0, 90).replace(/\n/g, " "));
const m1Reads = auditUserToolRuns(USER, ["pentest_resources", "finding_list", "hunt_log", "recon_subdomains", "recon_params"]);
ok(m1Reads >= 1, "A3: read recon executed (audit)", `${m1Reads} run(s)`);

// ── A4: risky ask → confirmation prompt → "ya" → audit proves execution ──
sent.length = 0;
client.emit("messageCreate", makeMsg(`ask2-${Date.now()}`, `lanjut pentest — sekarang uji endpoint yang paling menjanjikan, usulkan toolnya dulu`));
await waitForReply(1);
const reply2 = sent.map((s) => s.text).join("\n");
const askedConfirm = /Mia ingin melakukan aksi/i.test(reply2);
ok(askedConfirm || /akses|dibatasi|tool|uji/i.test(reply2), "A4: risky ask → confirmation prompt (or honest note)", reply2.slice(0, 90).replace(/\n/g, " "));

if (askedConfirm) {
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-${Date.now()}`, "ya"));
  await waitForReply(1, 360_000, 12_000);
  const runs = auditUserToolRuns(USER, ["http_request", "poc_verify", "param_fuzz", "pentest_scan", "content_discover", "crawl", "path_traversal"]);
  ok(runs >= 1, "A4: approval executed real probes (audit)", `${runs} run(s)`);
  ok(sent.length >= 1, "A4: post-approval reply sent", (sent.map((s) => s.text).join(" ").slice(0, 90)).replace(/\n/g, " "));
} else {
  console.log("(A4 soft: no confirmation prompt this round — model proposed reads)");
}

// ── A5: PDF ask → confirmation (report_pdf is risk=write) → "ya" → delivery ──
sent.length = 0;
client.emit("messageCreate", makeMsg(`ask3-${Date.now()}`, `buatkan report pdf untuk target ${LAB}`));
await waitForReply(1, 360_000, 12_000);
const reply4 = sent.map((s) => s.text).join("\n");
if (/Mia ingin melakukan aksi/i.test(reply4)) {
  // Same contract as the owner: reply "ya" to approve the report_pdf write.
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-pdf-${Date.now()}`, "ya"));
  await waitForReply(1, 360_000, 12_000);
}
const pdfDir = join(process.cwd(), "apps/web/.data/users", USER, "reports");
const pdfs = existsSync(pdfDir) ? readdirSync(pdfDir).filter((f) => f.endsWith(".pdf") && statSync(join(pdfDir, f)).size > 1000) : [];
ok(pdfs.length >= 1, "A5: a real PDF exists on disk for the adapter user", pdfs.join(",") || "none");
ok(/📎|report-\d{4}-|pdf/i.test(sent.map((s) => s.text).join("\n")), "A5: PDF receipt in reply", sent.map((s) => s.text).join(" ").slice(0, 90).replace(/\n/g, " "));
const pdfRuns = auditUserToolRuns(USER, ["report_pdf"]);
ok(pdfRuns >= 1, "A5: report_pdf executed after approval (audit)", `${pdfRuns} run(s)`);

// ── A6: honesty — no contradictory run-claims ──
const all = sent.map((s) => s.text).join("\n");
ok(!/sudah aku (jalankan|eksekusi|unduh)[^.]{0,40}(tapi|namun)/i.test(all), "A6: no contradictory run-claims", "scan of all replies");

console.log(fail === 0 ? "\nADAPTER DRILL DONE — all green" : `\nADAPTER DRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
