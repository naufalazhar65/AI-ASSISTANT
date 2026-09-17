// Report → styled print HTML for the PDF export.
//
// `generateReport` emits a small, fixed markdown dialect: one `#` title, a
// metadata line, an optional `>` scope callout, then `## N. [SEVERITY · CVSS x]
// title` findings whose body is `- **Label**: value` rows (values may wrap over
// several lines). The old exporter only did headings + `<br/>`, which printed as
// a wall of text. This renders it as a proper document: severity summary chips,
// a scope callout, one card per finding with a colour-coded badge, and labelled
// fields (evidence in monospace). Pure — unit-tested.

export type Severity = "critical" | "high" | "medium" | "low" | "info" | "none";

const SEVERITY_RE = /^\[([A-Z]+)(?:\s*·\s*CVSS\s*([\d.]+))?\]\s*(.*)$/;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline markdown on ALREADY-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function sevClass(sev: string): Severity {
  const s = sev.toLowerCase();
  return (["critical", "high", "medium", "low", "info"].includes(s) ? s : "none") as Severity;
}

/** A value is shown as evidence (monospace, wrapped) when it looks like data. */
function looksLikeEvidence(v: string): boolean {
  return /[{}]|^[A-Z]{3,7} \/|HTTP\/|→\s*\d{3}|\bPASS\b/.test(v) || v.includes("\n");
}

type Finding = { sev: Severity; cvss: string; title: string; rows: { label: string; value: string }[] };

/** Parse our report markdown into a compact document model. Pure. */
export function parseReport(md: string): {
  title: string;
  meta: string[];
  scope: string | null;
  counts: { total: number; bySev: Record<string, number>; avg: string } | null;
  findings: Finding[];
} {
  const lines = (md || "").split("\n");
  let title = "Laporan Pentest";
  const meta: string[] = [];
  let scope: string | null = null;
  let counts: { total: number; bySev: Record<string, number>; avg: string } | null = null;
  const findings: Finding[] = [];
  let cur: Finding | null = null;
  let lastRow: { label: string; value: string } | null = null;

  const pushCur = () => {
    if (cur) findings.push(cur);
    cur = null;
    lastRow = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      title = h1[1].trim() || title;
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      pushCur();
      const body = h2[1].trim().replace(/^\d+[.)]\s*/, "");
      const m = SEVERITY_RE.exec(body);
      const sev = m ? sevClass(m[1]) : "none";
      cur = { sev, cvss: m?.[2] ? m[2] : "", title: (m ? m[3] : body).trim(), rows: [] };
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      scope = (scope ? `${scope}\n` : "") + quote[1].trim();
      continue;
    }
    const total = /^Total temuan:\s*(\d+)\s*\(([^)]*)\)\s*—\s*rata-rata CVSS\s*([\d.]+)/i.exec(line);
    if (total) {
      const bySev: Record<string, number> = {};
      for (const part of total[2].split(/\s+/)) {
        const [k, v] = part.split(":");
        if (k && v !== undefined) bySev[k.toLowerCase()] = Number(v);
      }
      counts = { total: Number(total[1]), bySev, avg: total[3] };
      continue;
    }
    const row = /^-\s+\*\*(.+?)\*\*:\s*(.*)$/.exec(line);
    if (row && cur) {
      lastRow = { label: row[1].trim(), value: row[2].trim() };
      cur.rows.push(lastRow);
      continue;
    }
    // Continuation of the previous field (evidence/steps wrap over lines).
    if (cur && lastRow && line.trim()) {
      lastRow.value = `${lastRow.value}\n${line.trim()}`;
      continue;
    }
    if (!cur && line.trim()) meta.push(line.trim());
  }
  pushCur();
  return { title, meta, scope, counts, findings };
}

const SEV_COLOR: Record<Severity, { bg: string; border: string; text: string }> = {
  critical: { bg: "#b91c1c", border: "#b91c1c", text: "#ffffff" },
  high: { bg: "#c2410c", border: "#c2410c", text: "#ffffff" },
  medium: { bg: "#b45309", border: "#b45309", text: "#ffffff" },
  low: { bg: "#15803d", border: "#15803d", text: "#ffffff" },
  info: { bg: "#475569", border: "#475569", text: "#ffffff" },
  none: { bg: "#64748b", border: "#64748b", text: "#ffffff" },
};

const CSS = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1f2937; margin: 0; }
  h1 { font-size: 21pt; line-height: 1.2; margin: 0 0 2mm; color: #0f172a; letter-spacing: -0.2pt; }
  .meta { color: #64748b; font-size: 9.5pt; }
  .meta span + span::before { content: " · "; }
  .summary { display: flex; flex-wrap: wrap; gap: 3mm; margin: 7mm 0 5mm; }
  .chip { border: 1px solid #e2e8f0; border-radius: 6px; padding: 2.5mm 3.5mm; min-width: 26mm; }
  .chip .n { font-size: 15pt; font-weight: 700; color: #0f172a; line-height: 1.1; }
  .chip .l { font-size: 8pt; text-transform: uppercase; letter-spacing: .4pt; color: #64748b; }
  .chip.critical { border-left: 4px solid #b91c1c; }
  .chip.high { border-left: 4px solid #c2410c; }
  .chip.medium { border-left: 4px solid #b45309; }
  .chip.low { border-left: 4px solid #15803d; }
  .chip.info { border-left: 4px solid #475569; }
  .scope { background: #f8fafc; border-left: 3px solid #94a3b8; border-radius: 4px; padding: 3mm 4mm; margin: 0 0 6mm; font-size: 9.5pt; color: #334155; white-space: pre-wrap; }
  section.finding { border: 1px solid #e2e8f0; border-radius: 8px; padding: 4mm 4.5mm 3mm; margin: 0 0 5mm; }
  section.finding h2 { break-after: avoid-page; page-break-after: avoid; }
  section.finding dl.rows { break-inside: auto; }
  section.finding.sev-critical { border-left: 4px solid #b91c1c; }
  section.finding.sev-high { border-left: 4px solid #c2410c; }
  section.finding.sev-medium { border-left: 4px solid #b45309; }
  section.finding.sev-low { border-left: 4px solid #15803d; }
  section.finding.sev-info { border-left: 4px solid #475569; }
  section.finding h2 { font-size: 12pt; margin: 0 0 2.5mm; color: #0f172a; break-after: avoid; }
  .badge { display: inline-block; font-size: 8pt; font-weight: 700; letter-spacing: .3pt; color: #fff; border-radius: 4px; padding: 1mm 2.2mm; margin-right: 2mm; vertical-align: 1.2pt; }
  .cvss { font-size: 8.5pt; color: #64748b; font-weight: 600; margin-left: 2mm; }
  dl.rows { display: grid; grid-template-columns: 32mm 1fr; gap: 2mm 4mm; margin: 3mm 0 0; }
  dt { font-size: 8pt; text-transform: uppercase; letter-spacing: .4pt; color: #64748b; padding-top: 0.7mm; }
  dd { margin: 0; font-size: 9.8pt; color: #1f2937; }
  dd.pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.8pt; line-height: 1.45; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 4px; padding: 2.5mm 3mm; white-space: pre-wrap; word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9pt; background: #f1f5f9; border-radius: 3px; padding: 0.3mm 1mm; }
  .blank { color: #94a3b8; }
`;

/** Full print HTML for a report markdown document. Pure. */
export function renderReportHtml(md: string, opts: { footer?: string } = {}): string {
  const doc = parseReport(md);
  const chips = doc.counts
    ? (["critical", "high", "medium", "low", "info"] as const)
        .filter((s) => (doc.counts as { bySev: Record<string, number> }).bySev[s])
        .map((s) => `<div class="chip ${s}"><div class="n">${(doc.counts as { bySev: Record<string, number> }).bySev[s]}</div><div class="l">${s}</div></div>`)
        .join("")
        .concat(`<div class="chip"><div class="n">${doc.counts.avg}</div><div class="l">avg CVSS</div></div>`)
    : "";
  const meta = doc.meta.length ? `<div class="meta">${doc.meta.map((m) => `<span>${inline(esc(m))}</span>`).join("")}</div>` : "";
  const scope = doc.scope ? `<div class="scope">${inline(esc(doc.scope))}</div>` : "";
  const findings = doc.findings
    .map((f) => {
      const c = SEV_COLOR[f.sev];
      const badge = `<span class="badge" style="background:${c.bg}">${f.sev.toUpperCase()}</span>`;
      const rows = f.rows
        .map((r) => {
          const isPre = looksLikeEvidence(r.value);
          const value = inline(esc(r.value)).replace(/\n/g, "\n");
          return `<dt>${esc(r.label)}</dt><dd${isPre ? ' class="pre"' : ""}>${value || '<span class="blank">—</span>'}</dd>`;
        })
        .join("");
      return `<section class="finding sev-${f.sev}"><h2>${badge}${inline(esc(f.title))}${f.cvss ? `<span class="cvss">CVSS ${esc(f.cvss)}</span>` : ""}</h2><dl class="rows">${rows}</dl></section>`;
    })
    .join("");
  const footer = opts.footer ? `<div class="meta" style="margin-top:6mm">${esc(opts.footer)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${CSS}</style></head><body>
<h1>${esc(doc.title)}</h1>${meta}${chips ? `<div class="summary">${chips}</div>` : ""}${scope}${findings}${footer}
</body></html>`;
}

/**
 * Playwright PDF footer (page numbers). Playwright prints this template as-is,
 * so every style must be inline and the page counters must keep their exact
 * class names. Pure — unit-tested.
 */
export function reportFooterTemplate(title: string): string {
  const safe = esc((title || "Laporan").slice(0, 70));
  return (
    '<div style="width:100%;font-size:8pt;color:#94a3b8;padding:0 15mm;display:flex;justify-content:space-between;">' +
    `<span>${safe}</span>` +
    '<span>Halaman <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
  );
}
