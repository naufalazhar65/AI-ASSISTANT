// One-shot: poc_verify (3×, session=staff, expect 200) + finding_add (BOLA/IDOR
// staff-access) untuk dokumen internal Kohona — dispatch via executeTool, jalur
// persis yang dipakai agent; policy auto-approve lab owner meng-approve keduanya.
// Bukti = audit log `tool:poc_verify` / `tool:finding_add`.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !m[1].startsWith("NEXT_PUBLIC")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { executeTool } = await import("./src/lib/tools");
const USER = "naufalazhar652952";
const BASE = "https://cozy-kangaroo-42f2e0.netlify.app";
const DOC = `${BASE}/api/dokumen?id=4`;
const MARK = `staffverif-${Date.now()}`;

const mk = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

async function auditCounts(names: string[]): Promise<Record<string, number>> {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  const counts: Record<string, number> = {};
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".log")).sort().slice(-2);
    for (const f of files) {
      for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!l.includes(`"user":"${USER}"`)) continue;
        for (const n of names) if (l.includes(`"action":"tool:${n}"`)) counts[n] = (counts[n] || 0) + 1;
      }
    }
  } catch { /* belum ada */ }
  return counts;
}

const before = await auditCounts(["poc_verify", "finding_add"]);
console.log("audit sebelum:", JSON.stringify(before));

console.log("\n── poc_verify (3×, session=staff, expect 200) ──");
const poc = await executeTool(mk("pv1", "poc_verify", {
  url: DOC,
  session: "staff",
  times: 3,
  expect_status: 200,
  expect_contains: MARK + "|notulen", // marker run + konten rahasia
  save_evidence: true,
}), USER);
console.log(poc.slice(0, 700));

console.log("\n── finding_add (staff-access BOLA/IDOR) ──");
const add = await executeTool(mk("fa1", "finding_add", {
  title: "Staff dapat membaca dokumen internal rahasia via x-user-role (BOLA/IDOR) — Kohona",
  cvss: 7.5,
  owasp: "A01:2025 Broken Access Control",
  cwe: "CWE-639",
  target: BASE,
  evidence: `bola_diff A/B (admin vs staff, x-user-role): /api/dokumen?id=4 kedua sesi 200 identik (notulen-rapat-internal-mei.txt, rahasia=1). poc_verify session=staff 3x deterministik. marker-run: ${MARK}`,
  steps: `1) buat dua header sesi x-user-role (admin/staff). 2) GET ${DOC} dengan session staff. 3) respons 200 memuat notulen rapat internal (rahasia=1). 4) ulang 3x — deterministik.`,
  impact: "Akun staff (non-admin) membaca notulen rapat internal berkategori rahasia, termasuk realokasi anggaran Rp 1,24 M.",
  root_cause: "Otorisasi hanya membaca header klien x-user-role tanpa binding ke sesi/identitas server-side.",
  remediation: "Hapus kepercayaan pada header klien; otorisasi dari identitas sesi server-side; uji akses per-role otomatis.",
  retest_url: DOC,
  retest_method: "GET",
  retest_session: "staff",
  retest_status: 200,
  retest_expect: "notulen",
}), USER);
console.log(add.slice(0, 700));

const after = await auditCounts(["poc_verify", "finding_add"]);
console.log("\naudit sesudah:", JSON.stringify(after));
if (!(after.poc_verify > (before.poc_verify || 0)) || !(after.finding_add > (before.finding_add || 0))) {
  console.log("⛔ poc_verify/finding_add tidak terbukti di audit log");
  process.exit(1);
}
console.log("\nDONE — poc_verify & finding_add terbukti di audit log.");
process.exit(0);
