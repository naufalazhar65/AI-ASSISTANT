// drill-mdreport-adapter.mts — replay the LIVE 2026-09-25 14:09 owner turn
// through the REAL Discord adapter path and prove the reply is CLEAN now.
//
// The live turn (owner ask, verbatim): "mia coba lakukan full pentest secara
// menyeluruh di <LAB>/cek-nik dan buatkan report markdown nya" — ran report_save
// (.md written), the owner approved report_pdf (.pdf written), yet the reply
// carried TWO false "honest" notes: "tidak ada file PDF yang dibuat giliran ini"
// and "temuan ini BELUM masuk daftar". Three guard fixes landed; this drill
// proves the owner-experience path end-to-end against them.
//
// SAFETY (same invariant as drill-discord-adapter.mts): DISCORD_BOT_TOKEN is
// overwritten BEFORE import → login 401 at REST → gateway NEVER IDENTIFYs → the
// production bot session is untouched (no 409). msg.reply/channel.send are
// monkey-patched; nothing reaches Discord. Run from repo root:
//   npx tsx apps/web/drill-mdreport-adapter.mts
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
process.env.DISCORD_BOT_TOKEN = "invalid-token-adapter-drill-never-identifies";

const { startDiscordBot, getActiveDiscordClient } = await import("./src/channels/discord");

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_mdreport_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ASK = `mia coba lakukan full pentest secara menyeluruh di ${LAB}/cek-nik dan buatkan report markdown nya`;

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

const sent: string[] = [];
function capture(payload: unknown) {
  sent.push(String((payload as { content?: string })?.content ?? ""));
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
    id: "drill-channel-mdreport",
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

console.log(`── MD-REPORT ADAPTER DRILL (ask = live 14:09 verbatim) user=${USER} ──\n`);

await startDiscordBot();
await sleep(2500);
const client = getActiveDiscordClient();
ok(!!client, "A0: adapter client exists");
if (!client) process.exit(1);
ok(!(client as unknown as { isReady: () => boolean }).isReady(), "A0-safety: NO live gateway");
if ((client as unknown as { isReady: () => boolean }).isReady()) process.exit(1);

// ── the exact live ask ──
client.emit("messageCreate", makeMsg(`ask-${Date.now()}`, ASK));
await waitForReply(1, 420_000);

// Approve up to 2 write confirmations exactly like the owner did ("ya").
for (let round = 0; round < 2; round++) {
  const cur = sent.join("\n");
  if (!/Mia ingin melakukan aksi|Balas ya untuk lanjut/i.test(cur)) break;
  if (auditUserToolRuns(USER, ["report_pdf", "pentest_scan", "security_hunt", "suite_hunt"]) > round) break;
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-${round}-${Date.now()}`, "ya"));
  await waitForReply(1, 420_000, 12_000);
}

const all = sent.join("\n");
const savedMd = auditUserToolRuns(USER, ["report_save"]) >= 1;
const savedPdf = auditUserToolRuns(USER, ["report_pdf"]) >= 1;
const recorded = auditUserToolRuns(USER, ["finding_add"]) >= 1;
const mdReceipt = /report-[0-9A-Za-z:.()+_-]+\.md/i.test(all);
console.log(`\n[audit] report_save=${savedMd} report_pdf=${savedPdf} finding_add=${recorded}`);
console.log(`[reply tail] ${all.slice(-260).replace(/\n/g, " ")}\n`);

// B1: the turn really produced a report deliverable — either a report tool ran
// (audit) or the deterministic markdown delivery appended a real .md receipt
// (both write the file; the receipt names it).
ok(savedMd || savedPdf || mdReceipt, "B1: a report deliverable was really produced (audit or .md receipt)");

// B2: THE 14:09 LIE #1 — "tidak ada file PDF yang dibuat giliran ini" must
// never appear when report_pdf ran (and never contradict a .md receipt).
if (savedPdf) {
  ok(!/tidak ada file PDF yang dibuat giliran ini/i.test(all), "B2: no false 'no PDF made this turn' note (report_pdf ran)");
}
// B3: THE 14:09 LIE #2 — "BELUM masuk daftar" must not fire when finding_add
// ran, and (house rule) it must always come with the honest option to record.
if (recorded) {
  ok(!/BELUM masuk daftar/i.test(all), "B3: no false 'not recorded' note (finding_add ran)");
}

// B4: the markdown receipt — user asked for markdown; a report-*.md name must
// appear in the reply (tool receipt or deterministic delivery).
if (savedMd) {
  ok(/report-[0-9A-Za-z:.()+_-]+\.md/i.test(all), "B4: .md filename present in reply", (all.match(/report-[0-9A-Za-z:.()+_-]+\.md/i) || ["none"])[0]);
  const mdir = join(process.cwd(), "apps/web/.data/users", USER, "reports");
  const mds = existsSync(mdir) ? readdirSync(mdir).filter((f) => f.endsWith(".md") && statSync(join(mdir, f)).size > 500) : [];
  ok(mds.length >= 1, "B4-disk: the .md really exists", mds.join(",") || "none");
}

// B5: if the owner-style approval happened, a real PDF is on disk.
if (savedPdf) {
  const pdir = join(process.cwd(), "apps/web/.data/users", USER, "reports");
  const pdfs = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".pdf") && statSync(join(pdir, f)).size > 1000) : [];
  ok(pdfs.length >= 1, "B5: approved report_pdf produced a real file", pdfs.join(",") || "none");
}

// B6: general contradiction scan — a receipt and its denial must never sit in
// the same reply set.
ok(!(/(sudah kusimpan|sudah dibuat)[^\n]{0,80}\.pdf/i.test(all) && /tidak ada file PDF yang dibuat/i.test(all)), "B6: no receipt+denial contradiction");

console.log(fail === 0 ? "\nMD-REPORT DRILL DONE — reply is clean" : `\nMD-REPORT DRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
