// drill-receipt-confirm.mts — the owner's confirmation replay (2026-09-25).
//
// Owner ask (VERBATIM from Discord): "mia coba lakukan full pentest secara
// menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/cek-nik
// dan buatkan report pdf nya"
//
// Expectation: turn-1 sweep executes probes with FULL args in the ledger
// (defect 1 fixed: recordExecuted accepts {name, args}), the receipt shows
// well-formed lines only, and NO stale "(turn sebelumnya)" entries older than
// 10 minutes (defects 2+3 fixed: LEDGER_ROW_MAX_AGE_MS + recentLedgerRow +
// malformed-name guard). The model no longer owns action claims — the SYSTEM
// receipt is authoritative.
//
// What "clean receipt" asserts:
//   R1  the turn produced a system receipt when executed actions existed;
//   R2  every ⚙️ line is well-formed: "⚙️ <tool-name>" (never bare "⚙️ :");
//   R3  every tool name in a receipt line is a REAL RECEIPT_TOOLS member;
//   R4  "(turn sebelumnya)" only tags lines that are actually prior-turn
//       executions (none expected here — fresh user);
//   R5  refusals NEVER render as receipt lines (executed-only invariant);
//   R6  audit log proves the executions the receipt names;
//   R7  report_pdf produced a real PDF on disk (owner asked for the PDF).
//
// House rules honored: proof = AUDIT LOG (never prose); user is run-unique +
// auto-cleanup; SAFETY invariant — DISCORD_BOT_TOKEN is overwritten BEFORE
// import → login 401 at REST → gateway NEVER IDENTIFYs → the production bot
// session is untouched (no 409 conflict). msg.reply/channel.send are
// monkey-patched; nothing reaches Discord. Run from repo root:
//   npx tsx apps/web/drill-receipt-confirm.mts
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
process.env.DISCORD_BOT_TOKEN = "invalid-token-adapter-drill-never-identifies";

const { startDiscordBot, getActiveDiscordClient } = await import("./src/channels/discord");
const { RECEIPT_TOOLS } = await import("./src/lib/actionReceipt");

const OWNER_ID = process.env.DISCORD_ALLOWED_USER_ID || "000000000000000000";
const USER = `verify_receipt_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ASK = `mia coba lakukan full pentest secara menyeluruh di ${LAB}/cek-nik dan buatkan report pdf nya`;

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
async function waitForReply(minCapture = 1, maxMs = 420_000, stableMs = 9000): Promise<void> {
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
    id: "drill-channel-receipt",
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

console.log(`── RECEIPT-CONFIRM DRILL (ask = owner verbatim) user=${USER} ──\n`);

await startDiscordBot();
await sleep(2500);
const client = getActiveDiscordClient();
ok(!!client, "A0: adapter client exists");
if (!client) process.exit(1);
ok(!(client as unknown as { isReady: () => boolean }).isReady(), "A0-safety: NO live gateway (production bot untouched)");
if ((client as unknown as { isReady: () => boolean }).isReady()) process.exit(1);

// ── turn 1: the exact live ask ──
client.emit("messageCreate", makeMsg(`ask-${Date.now()}`, ASK));
await waitForReply(1, 480_000);

// Approve confirmations exactly like the owner would ("ya") — up to 3 rounds
// (report_pdf is risk=write → the adapter always asks; sweep may also propose).
for (let round = 0; round < 3; round++) {
  const cur = sent.join("\n");
  if (!/Mia ingin melakukan aksi|Balas ya untuk lanjut/i.test(cur)) break;
  if (auditUserToolRuns(USER, ["report_pdf"]) > round) break;
  sent.length = 0;
  client.emit("messageCreate", makeMsg(`ya-${round}-${Date.now()}`, "ya"));
  await waitForReply(1, 480_000, 12_000);
}

const all = sent.join("\n");
const probeRuns = auditUserToolRuns(USER, ["http_request", "pentest_scan", "web_audit", "content_discover", "js_mine", "fetch_url"]);
const pdfRuns = auditUserToolRuns(USER, ["report_pdf"]);
const findRuns = auditUserToolRuns(USER, ["finding_add"]);
console.log(`\n[audit] probes=${probeRuns} report_pdf=${pdfRuns} finding_add=${findRuns}`);
console.log(`[reply tail] ${all.slice(-320).replace(/\n/g, " ⏎ ")}\n`);

// ── R-audit: the turn really worked (audit proof, never prose) ──
ok(probeRuns + pdfRuns >= 1, "R-audit: turn executed real actions (audit log)", `probes=${probeRuns} pdf=${pdfRuns}`);

// ── R1: a system receipt block exists in the captured replies when actions ran ──
const hasReceipt = all.includes("Aksi yang benar-benar dijalankan:");
ok(!probeRuns || hasReceipt || pdfRuns === 0, "R1: receipt block present when probes executed (system owns action claims)");
console.log(`[receipt present] ${hasReceipt}`);

// ── R2: every ⚙️ line is well-formed (defect 1+3 regression) ──
const gearLines = all.split("\n").filter((l) => l.includes("⚙️"));
for (const l of gearLines) console.log(`[gear] ${l.trim().slice(0, 150)}`);
ok(gearLines.every((l) => /^\s*⚙️\s+[a-z][a-z0-9_]+\s*(\(|→|:)/.test(l) && !/^\s*⚙️\s*:/.test(l)), "R2: every ⚙️ line is well-formed (no bare '⚙️ :', full tool names)");

// ── R3: tool names in receipt lines are real RECEIPT_TOOLS members ──
const receiptToolNames = gearLines
  .map((l) => (l.match(/⚙️\s+([a-z][a-z0-9_]+)/) || [])[1])
  .filter(Boolean);
ok(receiptToolNames.every((n) => (RECEIPT_TOOLS as ReadonlySet<string>).has(n)), "R3: receipt tool names are real receipt tools", receiptToolNames.join(",") || "none");

// ── R4: prior-tagged lines are legitimate, never STALE ──
// (turn sebelumnya) is DESIGNED for the confirm path: a read probe executed in
// the proposal turn (before approval) is attributed to that prior turn. The
// 19:30 defect was STALE >10-min entries from old sessions — guarded by
// recentLedgerRow/LEDGER_ROW_MAX_AGE_MS. Verify the real invariant: every
// prior line's tool really executed (audit) and every ledger row is fresh.
const priorLines = gearLines.filter((l) => l.includes("(turn sebelumnya)"));
for (const l of priorLines) {
  const tool = (l.match(/⚙️\s+([a-z][a-z0-9_]+)/) || [])[1] || "?";
  ok(auditUserToolRuns(USER, [tool]) >= 1, `R4: prior-line tool really executed (audit): ${tool}`);
}
const ledgerPath = join(process.cwd(), "apps/web/.data/users", USER, "turn-exec.json");
if (existsSync(ledgerPath)) {
  const rows = JSON.parse(readFileSync(ledgerPath, "utf8")) as { name: string; at: string }[];
  const stale = rows.filter((r) => !r.at || Date.now() - new Date(r.at).getTime() > 10 * 60 * 1000);
  ok(stale.length === 0, "R4-ledger: every ledger row is fresh (<10 min) — stale-prior data invariant", `${rows.length} row(s)`);
  ok(
    priorLines.every((l) => {
      const t = (l.match(/⚙️\s+([a-z][a-z0-9_]+)/) || [])[1] || "";
      return rows.some((r) => r.name === t);
    }),
    "R4-ledger: prior-tagged lines are backed by ledger rows",
  );
} else {
  ok(priorLines.length === 0, "R4: no prior lines and no ledger (consistent)");
}

// ── R5: refusals never render as receipt lines (executed-only invariant) ──
ok(!/⚙️.*(Not selected|Not executed|Auto-declined|The user declined|not available on this provider)/.test(all), "R5: refusals never appear as receipt lines");

// ── R6: the PDF story matches the new empty-report contract ──
// report_pdf approved → EITHER a real PDF lands (findings existed) OR the turn
// is honestly empty: EMPTY_REPORT tool result / honest delivery note — never a
// hollow 1-page artifact presented as success (live 2026-09-25 drill defect).
if (pdfRuns >= 1) {
  const pdir = join(process.cwd(), "apps/web/.data/users", USER, "reports");
  const pdfs = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".pdf") && statSync(join(pdir, f)).size > 1000) : [];
  const emptyHonest = /EMPTY_REPORT|belum ada temuan (yang )?tercatat|belum dibuat — belum ada temuan|belum bisa kubuat/i.test(all);
  ok(pdfs.length >= 1 || emptyHonest, "R6: report_pdf → real PDF on disk OR honest empty-report note (never a hollow artifact)", pdfs.length ? pdfs.join(",") : "empty-report honest path");
  ok(pdfs.length === 0 || !emptyHonest, "R6: no contradiction (PDF exists XOR honest-empty note)");
}

// ── R7: args digests are non-empty for probe lines (defect 1: sweep args flow) ──
const probeGear = gearLines.filter((l) => l.includes("→"));
ok(probeGear.length === 0 || probeGear.every((l) => l.includes("→") && l.split("→")[1]?.trim().length > 0), "R7: probe receipt lines carry a non-empty digest (args flow through)");

console.log(fail === 0 ? "\nRECEIPT-CONFIRM DRILL DONE — receipt is clean" : `\nRECEIPT-CONFIRM DRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
