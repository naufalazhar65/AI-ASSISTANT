// Report → styled print HTML for the PDF export.
//
// `generateReport` emits a small, fixed markdown dialect: one `#` title, a
// metadata line, an optional `>` scope callout, then `## N. [SEVERITY · CVSS x]
// title` findings whose body is `- **Label**: value` rows (values may wrap over
// several lines). This renders it as a professional document (Paket B, 2026-09-26):
// dark header band with target + confidentiality mark, severity summary chips +
// deterministic executive summary, remediation priority, finding TOC, one card
// per finding with a colour-coded badge and category tags, numbered repro steps,
// and an EVIDENCE panel with the poc_verify chip promoted. Pure — tested.

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
  let title = "Pentest Report";
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
    const total = /^Total (?:temuan|findings):\s*(\d+)\s*\(([^)]*)\)\s*—\s*(?:rata-rata CVSS|average CVSS)\s*([\d.]+)/i.exec(line);
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

/** Industry-standard severity palette (low = blue — green reads as "good done"). */
const SEV_COLOR: Record<Severity, { bg: string; border: string; text: string }> = {
  critical: { bg: "#dc2626", border: "#dc2626", text: "#ffffff" },
  high: { bg: "#ea580c", border: "#ea580c", text: "#ffffff" },
  medium: { bg: "#d97706", border: "#d97706", text: "#ffffff" },
  low: { bg: "#2563eb", border: "#2563eb", text: "#ffffff" },
  info: { bg: "#64748b", border: "#64748b", text: "#ffffff" },
  none: { bg: "#64748b", border: "#64748b", text: "#ffffff" },
};

/**
 * Split a Kategori value ("A05:2025 Injection / CWE-89, CWE-200") into small
 * tag chips. Splits on / and , only — never on spaces (OWASP labels survive).
 * Pure. Tested.
 */
export function sevTags(raw: string): string[] {
  return (raw || "")
    .split(/\s*\/\s*|\s*,\s*/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * Detect a single-line numbered repro recipe ("1. GET … 2. Add quote …") and
 * split it into steps. Boundaries are ANCHORED to the expected sequence
 * (1., then 2., then 3. …): a stray "N. ". after a value like "200." or
 * "1.240.000" is ignored unless it continues the chain, and the `\s+` after
 * the dot keeps decimals (1.240.000.000, 3.14) out entirely. Multi-line
 * values stay evidence-style (pre). Returns null when not a recipe. Pure. Tested.
 */
export function splitSteps(v: string): string[] | null {
  const t = (v || "").trim();
  if (!t || t.includes("\n")) return null;
  const re = /(?<=^|\s)(\d{1,2})\.\s+/g;
  const marks: Array<{ start: number; end: number; n: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) marks.push({ start: m.index, end: m.index + m[0].length, n: Number(m[1]) });
  // Walk marks keeping only the expected chain 1., 2., 3. … (stray numbers skipped).
  const chain: Array<{ start: number; end: number }> = [];
  let expect = 1;
  for (const k of marks) {
    if (k.n === expect) {
      chain.push(k);
      expect++;
    } else if (k.n < expect) {
      continue; // e.g. "200." inside step 1 — not a boundary
    } else {
      return null; // jumped sequence — not a numbered recipe
    }
  }
  if (chain.length < 2 || chain[0].start !== 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const stop = i + 1 < chain.length ? chain[i + 1].start : t.length;
    parts.push(t.slice(chain[i].end, stop).trim());
  }
  return parts.slice(0, 20);
}

/**
 * Deterministic 2-sentence executive summary from the counts line — the PDF
 * must never depend on an LLM for its summary. Pure. Tested.
 */
export function execSummary(
  counts: { total: number; bySev: Record<string, number>; avg: string } | null
): string {
  if (!counts) return "";
  const label: Record<string, string> = {
    critical: "critical",
    high: "high",
    medium: "medium",
    low: "low",
    info: "informational",
  };
  const items = (["critical", "high", "medium", "low", "info"] as const)
    .map((s) => ({ s, n: counts.bySev[s] ?? 0 }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${label[x.s]}`);
  if (!items.length) return "No open findings in this report.";
  const level = counts.bySev.critical
    ? "CRITICAL"
    : counts.bySev.high
      ? "HIGH"
      : counts.bySev.medium
        ? "MEDIUM"
        : counts.bySev.low
          ? "LOW"
          : "MINIMAL";
  return `Found ${counts.total} findings: ${items.join(", ")}. Average CVSS ${counts.avg} — overall risk level ${level}.`;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, none: 5 };

/** Highest-severity findings first (CVSS desc within a rank). Pure. Tested. */
export function topRemediation(findings: Finding[], n = 3): Finding[] {
  return [...(findings || [])]
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || parseFloat(b.cvss || "0") - parseFloat(a.cvss || "0"))
    .slice(0, n);
}

const CSS = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1f2937; margin: 0; }
  .band { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; background: #0f172a; border-radius: 8px; padding: 5mm 6mm; margin: 0 0 5mm; break-inside: avoid; }
  .band-title { font-size: 17pt; font-weight: 700; color: #ffffff; line-height: 1.18; letter-spacing: -0.2pt; }
  .band-sub { font-size: 8.5pt; color: #94a3b8; margin-top: 1.5mm; }
  .band-sub b { color: #cbd5e1; font-weight: 600; }
  .band-right { text-align: right; white-space: nowrap; }
  .band-host { font-size: 9pt; font-weight: 600; color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .band-conf { display: inline-block; margin-top: 2mm; font-size: 7.5pt; letter-spacing: .6pt; color: #fecaca; border: 1px solid #7f1d1d; background: #450a0a; border-radius: 3px; padding: 1mm 2mm; font-weight: 700; }
  .summary { display: flex; flex-wrap: wrap; gap: 3mm; margin: 0 0 4mm; }
  .chip { border: 1px solid #e2e8f0; border-radius: 6px; padding: 2.5mm 3.5mm; min-width: 26mm; }
  .chip .n { font-size: 15pt; font-weight: 700; color: #0f172a; line-height: 1.1; }
  .chip .l { font-size: 8pt; text-transform: uppercase; letter-spacing: .4pt; color: #64748b; }
  .chip.critical { border-left: 4px solid #dc2626; }
  .chip.high { border-left: 4px solid #ea580c; }
  .chip.medium { border-left: 4px solid #d97706; }
  .chip.low { border-left: 4px solid #2563eb; }
  .chip.info { border-left: 4px solid #64748b; }
  .exec { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #0f172a; border-radius: 6px; padding: 3mm 4mm; font-size: 9.8pt; color: #334155; margin: 0 0 5mm; }
  .scope { background: #f8fafc; border-left: 3px solid #94a3b8; border-radius: 4px; padding: 3mm 4mm; margin: 0 0 5mm; font-size: 9.5pt; color: #334155; white-space: pre-wrap; }
  .prio { border: 1px solid #e2e8f0; border-radius: 8px; padding: 3.5mm 4.5mm; margin: 0 0 5mm; break-inside: avoid; }
  .prio h3, .toc h3 { font-size: 9.5pt; margin: 0 0 2mm; text-transform: uppercase; letter-spacing: .5pt; color: #64748b; }
  .prio ol { margin: 0; padding-left: 5mm; font-size: 9.8pt; color: #1f2937; }
  .prio li { margin: 1mm 0; }
  .prio .mini { font-size: 8pt; color: #64748b; font-weight: 600; margin-left: 1.5mm; white-space: nowrap; }
  .toc { border: 1px solid #e2e8f0; border-radius: 8px; padding: 3.5mm 4.5mm 2.5mm; margin: 0 0 6mm; break-inside: avoid; }
  .toc ol { margin: 0; padding-left: 5mm; font-size: 9.3pt; color: #334155; }
  .toc li { margin: 0.8mm 0; }
  .toc .badge { font-size: 6.5pt; padding: 0.5mm 1.4mm; margin-right: 1.5mm; vertical-align: 0.6pt; }
  section.finding { border: 1px solid #e2e8f0; border-radius: 8px; padding: 4mm 4.5mm 3.5mm; margin: 0 0 5mm; }
  section.finding h2 { font-size: 12pt; margin: 0 0 2mm; color: #0f172a; break-after: avoid; page-break-after: avoid; }
  section.finding.sev-critical { border-left: 4px solid #dc2626; }
  section.finding.sev-high { border-left: 4px solid #ea580c; }
  section.finding.sev-medium { border-left: 4px solid #d97706; }
  section.finding.sev-low { border-left: 4px solid #2563eb; }
  section.finding.sev-info { border-left: 4px solid #64748b; }
  .badge { display: inline-block; font-size: 8pt; font-weight: 700; letter-spacing: .3pt; color: #fff; border-radius: 4px; padding: 1mm 2.2mm; margin-right: 2mm; vertical-align: 1.2pt; }
  .cvss { font-size: 8.5pt; color: #64748b; font-weight: 600; margin-left: 2mm; white-space: nowrap; }
  .tags { margin: 0 0 2.5mm; display: flex; flex-wrap: wrap; gap: 1.5mm; }
  .tag { font-size: 7.8pt; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; border-radius: 3px; padding: 0.6mm 1.6mm; }
  dl.rows { display: grid; grid-template-columns: 32mm 1fr; gap: 2mm 4mm; margin: 2.5mm 0 0; }
  dt { font-size: 8pt; text-transform: uppercase; letter-spacing: .4pt; color: #64748b; padding-top: 0.7mm; }
  dd { margin: 0; font-size: 9.8pt; color: #1f2937; }
  dd.pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.8pt; line-height: 1.45; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 4px; padding: 2.5mm 3mm; white-space: pre-wrap; word-break: break-word; }
  dd.steps-cell { padding-top: 0.4mm; }
  ol.steps { margin: 0; padding-left: 4.5mm; font-size: 9.6pt; color: #1f2937; }
  ol.steps li { margin: 0.6mm 0; }
  ol.steps code { font-size: 8.8pt; }
  .panel { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 2.5mm 3mm; margin-top: 2.5mm; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5mm; }
  .ptitle { font-size: 7.5pt; font-weight: 700; letter-spacing: .6pt; color: #64748b; }
  .poc { font-size: 8pt; font-weight: 700; color: #15803d; background: #dcfce7; border: 1px solid #86efac; border-radius: 3px; padding: 0.6mm 1.8mm; }
  .panel pre { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.4pt; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: #1f2937; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9pt; background: #f1f5f9; border-radius: 3px; padding: 0.3mm 1mm; }
  .blank { color: #94a3b8; }
  .meta { color: #64748b; font-size: 9.5pt; }
`;

/** Full print HTML for a report markdown document. Pure. */
export function renderReportHtml(md: string, opts: { footer?: string } = {}): string {
  const doc = parseReport(md);

  // Header band: title + engagement/date on the left, target host + a
  // confidentiality mark on the right. Engagement/Scope lines move into the
  // band; the callout keeps only the remaining lines (e.g. Izin/authorization).
  const created = doc.meta.find((m) => /^(?:Dibuat|Generated):/i.test(m))?.replace(/^(?:Dibuat|Generated):\s*/i, "") ?? "";
  const scopeLines = (doc.scope ?? "").split("\n");
  const engLine = scopeLines.find((l) => /^Engagement:/i.test(l))?.replace(/^Engagement:\s*/i, "") ?? "";
  const hostLine = scopeLines.find((l) => /^Scope:/i.test(l))?.replace(/^Scope:\s*/i, "") ?? "";
  // A real host has no whitespace; "LAB MILIK OWNER / aset sendiri" stays a callout.
  const hostLooksReal = !!hostLine && !/\s/.test(hostLine.replace(/^https?:\/\//, "").split("/")[0]);
  const shortHost = hostLooksReal ? hostLine.replace(/^https?:\/\//, "").split("/")[0].slice(0, 48) : "";
  const restScope = scopeLines
    .filter((l) => l.trim() && !/^(Engagement):/i.test(l) && !(hostLooksReal && /^Scope:/i.test(l)))
    .join("\n")
    .trim();

  const band = `<div class="band"><div><div class="band-title">${esc(doc.title)}</div><div class="band-sub">${engLine ? `<b>${esc(engLine)}</b>${created ? " · " : ""}` : ""}${created ? `Generated ${esc(created.slice(0, 10))}` : ""}</div></div><div class="band-right">${shortHost ? `<div class="band-host">${esc(shortHost)}</div>` : ""}<div class="band-conf">CONFIDENTIAL — INTERNAL</div></div></div>`;

  const chips = doc.counts
    ? (["critical", "high", "medium", "low", "info"] as const)
        .filter((s) => (doc.counts as { bySev: Record<string, number> }).bySev[s])
        .map((s) => `<div class="chip ${s}"><div class="n">${(doc.counts as { bySev: Record<string, number> }).bySev[s]}</div><div class="l">${s}</div></div>`)
        .join("")
        .concat(`<div class="chip"><div class="n">${doc.counts.avg}</div><div class="l">avg CVSS</div></div>`)
    : "";
  const exec = execSummary(doc.counts);
  const execBlock = exec ? `<p class="exec">${esc(exec)}</p>` : "";
  const scopeBlock = restScope ? `<div class="scope">${inline(esc(restScope))}</div>` : "";

  const prio = topRemediation(doc.findings);
  const prioBlock = prio.length
    ? `<div class="prio"><h3>Remediation Priority</h3><ol>${prio
        .map((f) => `<li>${inline(esc(f.title))}${f.cvss ? ` <span class="mini">CVSS ${esc(f.cvss)}</span>` : ""}</li>`)
        .join("")}</ol></div>`
    : "";
  const tocBlock = doc.findings.length
    ? `<div class="toc"><h3>Findings Index</h3><ol>${doc.findings
        .map((f) => {
          const c = SEV_COLOR[f.sev];
          return `<li><span class="badge" style="background:${c.bg}">${f.sev.toUpperCase()}</span>${inline(esc(f.title))}</li>`;
        })
        .join("")}</ol></div>`
    : "";

  const findings = doc.findings
    .map((f) => {
      const c = SEV_COLOR[f.sev];
      const badge = `<span class="badge" style="background:${c.bg}">${f.sev.toUpperCase()}</span>`;
      const katRow = f.rows.find((r) => ["kategori", "category"].includes(r.label.toLowerCase()));
      const tags = katRow ? sevTags(katRow.value) : [];
      const evRows = f.rows.filter((r) => r.label.toLowerCase().startsWith("evidence"));
      const gridRows = f.rows.filter((r) => r !== katRow && !evRows.includes(r));
      const cells = gridRows
        .map((r) => {
          const steps = r.label.toLowerCase().startsWith("steps") ? splitSteps(r.value) : null;
          if (steps) {
            const items = steps.map((s) => `<li>${inline(esc(s))}</li>`).join("");
            return `<dt>${esc(r.label)}</dt><dd class="steps-cell"><ol class="steps">${items}</ol></dd>`;
          }
          const isPre = looksLikeEvidence(r.value);
          const value = inline(esc(r.value));
          return `<dt>${esc(r.label)}</dt><dd${isPre ? ' class="pre"' : ""}>${value || '<span class="blank">—</span>'}</dd>`;
        })
        .join("");
      const tagBlock = tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "";
      const panels = evRows
        .map((r) => {
          const poc = /poc_verify\s+\d+\/\d+\s+PASS/i.exec(r.value)?.[0];
          const chip = poc ? `<span class="poc">✔ ${esc(poc)}</span>` : "";
          return `<div class="panel"><div class="panel-head"><span class="ptitle">EVIDENCE</span>${chip}</div><pre>${esc(r.value)}</pre></div>`;
        })
        .join("");
      return `<section class="finding sev-${f.sev}"><h2>${badge}${inline(esc(f.title))}${f.cvss ? `<span class="cvss">CVSS ${esc(f.cvss)}</span>` : ""}</h2>${tagBlock}<dl class="rows">${cells}</dl>${panels}</section>`;
    })
    .join("");

  const footer = opts.footer ? `<div class="meta" style="margin-top:6mm">${esc(opts.footer)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${CSS}</style></head><body>
${band}${chips ? `<div class="summary">${chips}</div>` : ""}${execBlock}${scopeBlock}${prioBlock}${tocBlock}${findings}${footer}
</body></html>`;
}

/**
 * Playwright PDF footer (page numbers). Playwright prints this template as-is,
 * so every style must be inline and the page counters must keep their exact
 * class names. Pure — unit-tested.
 */
export function reportFooterTemplate(title: string): string {
  const safe = esc((title || "Report").slice(0, 70));
  return (
    '<div style="width:100%;font-size:8pt;color:#94a3b8;padding:0 15mm;display:flex;justify-content:space-between;">' +
    `<span>${safe}</span>` +
    '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
  );
}
