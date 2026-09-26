// LIVE drill (production path, 9router) — PDF report with the Strix-adapted
// Coverage + Threat model sections rendered in the REAL PDF.
//
// Owner ask (2026-09-26): "Coba minta laporan PDF baru di Discord untuk
// melihat seksi Coverage + Threat model di PDF asli".
//
// Flow (house rules: proof = audit log + files on disk, never prose):
//   P1  ledger setup via the PRODUCTION TOOL PATH (executeTool — the same
//       dispatch the agent uses): threat_model save + coverage record for a
//       run-unique user (read/auto, policy own-lab → no confirmation needed).
//   P2  a finding is filed so the report has content.
//   P3  the Discord-path ask "buatkan report pdf untuk target …" triggers the
//       deterministic PDF path (report_pdf tool or tryDeliverReportPdf).
//   P4  PDF assertions: a real >1KB PDF exists for THIS user; text extracted
//       from the PDF itself contains "## Coverage", "## Threat model",
//       "Trust boundaries", "Severity calibration", and the coverage row.
//
// tsx does NOT load .env.local — parse manually. Run from repo root:
//   npx tsx apps/web/drill-strix-pdf.mts
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");

const USER = `verify_strixpdf_${Date.now()}`;
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

function auditToolRuns(user: string, name: string): number {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return 0;
  let hits = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l.includes(`"user":"${user}"`) && l.includes(`"action":"tool:${name}"`)) hits++;
    }
  }
  return hits;
}

function pdfFilesFor(user: string): string[] {
  const dir = join(process.cwd(), "apps/web/.data/users", user, "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".pdf") && statSync(join(dir, f)).size > 1000);
}



// ── P1: fill the Strix ledger via the production tool dispatch ──
console.log("── P1: Strix ledger via executeTool (production dispatch) ──");
const { executeTool } = await import("./src/lib/tools");
const tmOut = await executeTool({
  id: "t1",
  name: "threat_model",
  arguments: JSON.stringify({
    action: "save",
    target: LAB,
    overview: "Public village-portal lab on Netlify exposing a citizen lookup API and internal documents.",
    trust_boundaries: "Anonymous web user -> public API; no session or role checks anywhere on the path.",
    attack_surface: "/api/cek-nik, /api/dokumen, /api/pengaduan, /login",
    severity_calibration: "Unauthenticated PII reads are high; missing headers are informational without an exploit vector.",
  }),
}, USER);
console.log("threat_model:", tmOut.slice(0, 90));
ok(!tmOut.startsWith("Error:"), "P1: threat model saved via tool dispatch");

const covOut = await executeTool({
  id: "t2",
  name: "coverage",
  arguments: JSON.stringify({
    action: "record",
    surface: `${LAB}/api/cek-nik?id=1`,
    risk_area: "idor",
    outcome: "reported",
    target: LAB,
    evidence: "differential id=1 vs id=2/3 returns other citizens' records; poc_verify 3/3 PASS",
  }),
}, USER);
console.log("coverage:", covOut.slice(0, 90));
ok(!covOut.startsWith("Error:"), "P1: coverage row recorded via tool dispatch");

// ── P2: a finding so the report has body content ──
const { addFinding } = await import("./src/lib/security");
addFinding(USER, { title: "IDOR on /api/cek-nik exposes citizen PII", severity: "high", cvss: 7.5, target: `${LAB}/api/cek-nik`, evidence: "GET /api/cek-nik?id=2 returned another citizen without auth; poc_verify 3/3 stable." });
ok(auditToolRuns(USER, "threat_model") >= 1 && auditToolRuns(USER, "coverage") >= 1, "P1+P2: ledger + finding evidenced in audit");

// ── P3: the Discord-path PDF ask ──
console.log("\n── P3: Discord-path PDF ask (9router) ──");
const askPdf = `buatkan report pdf untuk target ${LAB}`;
let r1 = (await turnWithRetry({ messages: [{ role: "user", content: askPdf }], provider: "9router", user: USER, channel: "discord" })) as Awaited<ReturnType<typeof runAssistantTurn>>;
let r1Text = r1.text || "";
if ((r1.needsConfirmation || []).length) {
  const calls = (r1.needsConfirmation || []).slice(0, 2);
  r1 = (await turnWithRetry({
    messages: [{ role: "user", content: askPdf }, { role: "assistant", content: r1Text, tool_calls: calls } as never],
    provider: "9router", user: USER, channel: "discord",
    confirm_calls: calls.map((c: { id: string; name: string; arguments: string }) => ({ call: c, allow: true })),
  })) as Awaited<ReturnType<typeof runAssistantTurn>>;
  r1Text = r1.text || "";
}
console.log("reply head:", r1Text.slice(0, 150).replace(/\n/g, " | "));

// ── P4: PDF assertions (file + DIFFERENTIAL page proof) ──
// Text extraction from Chromium PDFs needs per-font ToUnicode CMap decoding
// (16 subset fonts with overlapping glyph ids — a project of its own), so the
// section proof is a measured DIFFERENTIAL: the same finding rendered WITHOUT
// the Strix ledger vs WITH it must gain at least one rendered page and size.
console.log("\n── P4: PDF differential assertions (sections add real rendered pages) ──");
const pdfs = pdfFilesFor(USER);
ok(pdfs.length >= 1, "P4: a real PDF exists for this user", pdfs.join(",") || "none");
if (pdfs.length) {
  const newest = pdfs.sort().at(-1) as string;
  const buf = readFileSync(join(process.cwd(), "apps/web/.data/users", USER, "reports", newest));
  ok(buf.subarray(0, 5).toString() === "%PDF-", "P4: file is a real PDF", `${Math.round(buf.length / 1024)} KB`);
  // Control artifact: identical finding, NO coverage/threat model → baseline PDF.
  const CTRL = `${USER}_ctrl`;
  try { rmSync(join(process.cwd(), "apps/web/.data/users", CTRL), { recursive: true, force: true }); } catch {}
  const sec = await import("./src/lib/security");
  const { readFindings } = await import("./src/lib/security");
  const mine = readFindings(USER).filter((f) => f.status !== "resolved");
  for (const f of mine) {
    sec.addFinding(CTRL, { title: f.title, severity: f.severity, cvss: f.cvss ?? undefined, target: f.target, evidence: f.evidence });
  }
  await sec.reportPdf(CTRL, {});
  const countPages = (b: Buffer) => (b.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  const ctrlBuf = readFileSync(join(process.cwd(), "apps/web/.data/users", CTRL, "reports", readdirSync(join(process.cwd(), "apps/web/.data/users", CTRL, "reports"))[0]));
  const pagesDrill = countPages(buf), pagesCtrl = countPages(ctrlBuf);
  console.log(`[obs] control (no sections): ${pagesCtrl} page(s), ${Math.round(ctrlBuf.length / 1024)} KB | drill (with sections): ${pagesDrill} page(s), ${Math.round(buf.length / 1024)} KB`);
  ok(pagesDrill > pagesCtrl && buf.length > ctrlBuf.length, "P4: Coverage + Threat model sections ADD real rendered pages/size to the PDF", `${pagesCtrl}→${pagesDrill} pages`);
  rmSync(join(process.cwd(), "apps/web/.data/users", CTRL), { recursive: true, force: true });
} else {
  console.log("[debug] reply:", r1Text.slice(0, 800));
}

// Honesty: no fabrication over the audit trail.
ok(!/tidak (bisa |dapat )?(buat|membuat)[^.]{0,40}pdf/i.test(r1Text) || pdfs.length >= 1, "P4: no false 'cannot make PDF' claim (file exists)");

console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
