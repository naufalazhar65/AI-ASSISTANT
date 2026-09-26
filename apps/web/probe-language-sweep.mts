// probe-language-sweep.mts — pre-commit language sweep for DELIVERABLES.
// Chat/receipt stay Indonesian by design; .md/PDF/writeup/hardening must be English.
// Run: npx tsx apps/web/probe-language-sweep.mts
import { generateReport, hardeningPlan } from "./src/lib/security";
import { renderWriteup } from "./src/lib/writeup";
import { renderReportHtml } from "./src/lib/reportHtml";
import { readFindings } from "./src/lib/security";

const LAB = "6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
// Words that should never appear in an English deliverable (template prose).
// Raw quoted evidence from the target is intentionally exempt.
const ID_RE = /\b(laporan|temuan|dibuat|rata-rata|langkah|dampak|bukti|rekomendasi|ringkasan|kesimpulan|belum ada|tidak ada|kategori|berikut|terlampir|diajukan)\b/gi;

let failures = 0;
/**
 * Drop `- **Evidence**:` value blocks before scanning: they are QUOTED RAW
 * EVIDENCE from the target (e.g. the lab's own Indonesian JSON documents) and
 * are intentionally NOT translated — translating raw proof would falsify it.
 * Template prose and finding FIELDS stay in the scan.
 */
function withoutEvidenceBlocks(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (/^- \*\*Evidence\*\*:/im.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^- \*\*/.test(line) || /^#{1,3} /.test(line) || /^> /.test(line))) skipping = false;
    if (skipping) continue;
    out.push(line);
  }
  return out.join("\n");
}
function check(name: string, text: string) {
  const scannable = withoutEvidenceBlocks(text);
  const hits = [...new Set((scannable.match(ID_RE) || []).map((w) => w.toLowerCase()))];
  if (hits.length) {
    failures++;
    console.log(`✗ ${name}: ID words → ${hits.join(", ")}`);
  } else {
    console.log(`✓ ${name}: English-clean (${text.length} chars)`);
  }
}

const findings = readFindings("naufalazhar652952").filter((f) => f.status !== "resolved");
console.log(`store: ${findings.length} open findings (evidence blocks exempt from scan — raw proof stays as-is)`);

check("generateReport (md)", generateReport("naufalazhar652952", { target: LAB }));
check("hardeningPlan", hardeningPlan("naufalazhar652952"));
const first = findings[0];
if (first) check("renderWriteup (newest finding)", renderWriteup(first));

const md = generateReport("naufalazhar652952", { target: LAB });
// Scan the PDF body template on the md WITHOUT evidence blocks: the renderer
// wraps raw evidence values in monospace panels (still the target's own
// untranslated proof — out of scope for a language scan).
check("renderReportHtml (PDF body)", renderReportHtml(withoutEvidenceBlocks(md), { footer: "Mia — report report · 2026-09-26" }));

if (failures) {
  console.log(`\nRESULT: FAIL — ${failures} deliverable(s) masih mengandung Indonesia`);
  process.exit(1);
}
console.log("\nRESULT: PASS — semua deliverable English-clean");
