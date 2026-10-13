/**
 * Channel rendering — presentation only, never content.
 *
 * The contract from the brief: "one content source, two renders". So this
 * module takes the SAME answer and only changes its markdown dialect:
 *
 *  - chat    : GitHub-flavoured Markdown, passed through untouched.
 *  - discord : headings are not a Discord concept -> render as bold lines;
 *              markdown tables are not rendered either -> flatten to list rows.
 *  - slack   : mrkdwn (single-asterisk bold, `<url|label>` links, no headings,
 *              no tables).
 *  - plain   : identity (voice/TTS stays plain by prompt, not by mangling).
 *
 * Hard invariants (all covered by tests):
 *  1. No source link is ever dropped.
 *  2. No content line is ever dropped — only its decoration changes.
 *  3. Content inside fenced code blocks is never touched.
 *  4. Any unexpected input returns the input unchanged (fail-safe, never throws).
 *
 * Embeds are deliberately NOT used. This repo's Discord send path passes
 * `flags: [MessageFlags.SuppressEmbeds]`, so an embed-based report would render
 * as nothing at all — verified in channels/discord.ts.
 */

import { SECTION_LABELS } from "./registry";
import { normalizeLabel } from "./validate";
import type { FormatChannel } from "./taskTypes";

/** True when the line is nothing but a recognised section label. */
function isSectionLabel(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 64) return false;
  // Already decorated anywhere in the line. Two real captures:
  //   `**KESIMPULAN**`        -> the first-char check caught it, but
  //   `📊 **KESIMPULAN**`     -> the emoji sits BEFORE the asterisks, so a
  //                              first-char check missed it and produced
  //                              `**📊 **KESIMPULAN****`.
  // The emoji itself is the model's own style and must survive; only the
  // already-bold decoration must not be applied twice.
  if (/[#*_~`]/.test(t)) return false;
  const label = normalizeLabel(t);
  if (!label) return false;
  if (SECTION_LABELS.has(label)) return true;
  for (const alias of SECTION_LABELS) {
    if (label.startsWith(`${alias} `) || label.startsWith(`${alias}:`)) return true;
  }
  return false;
}

export interface RenderResult {
  text: string;
  /** True when the dialect actually changed something. */
  transformed: boolean;
  /** Short note for the audit trail / tests. */
  note: string;
}

const URL_RE = /https?:\/\/[^\s)>\]]+/g;

function countUrls(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;

/**
 * Split into fenced and free segments. Everything inside ``` or ~~~ fences is
 * passed through byte-for-byte; everything else is handed to `mapLine`.
 */
function mapFenceAware(text: string, mapLine: (line: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence == null && m) {
      fence = m[1][0];
      out.push(line);
      continue;
    }
    if (fence != null) {
      if (m && m[1][0] === fence) fence = null;
      out.push(line);
      continue;
    }
    out.push(mapLine(line));
  }
  return out.join("\n");
}

function isTableDelimiter(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
}

/**
 * Flatten a GFM table into list rows: `| a | b |` -> `- a: b`, using the header
 * row as labels. Every cell value survives, which is what the "nothing dropped"
 * invariant requires.
 */
function flattenTable(lines: string[], start: number, end: number): string[] {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[start]);
  const out: string[] = [];
  for (let i = start + 1; i <= end; i += 1) {
    const line = lines[i];
    if (!line.includes("|")) continue;
    if (isTableDelimiter(line)) continue;
    const row = cells(line);
    const rendered = row
      .map((cell, idx) => (idx === 0 ? cell : `${header[idx] ?? `col ${idx + 1}`}: ${cell}`))
      .filter((s) => s.length > 0);
    if (rendered.length > 0) out.push(`- ${rendered.join(" — ")}`);
  }
  return out;
}

/** Drop ATX headings (rendered as bold lines by the caller instead). */
function dropHeadings(text: string): { text: string; headings: string[] } {
  const headings: string[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m = HEADING_RE.exec(line);
      if (m) {
        const title = m[2].trim();
        if (title) headings.push(title);
        continue;
      }
    }
    out.push(line);
  }
  return { text: out.join("\n"), headings };
}

function renderDiscord(text: string): RenderResult {
  const before = countUrls(text);
  const { text: noHeadings, headings } = dropHeadings(text);
  // Re-attach headings as bold lines, in place, so structure survives.
  const lines = noHeadings.split("\n");
  const withBold: string[] = [];
  let hIdx = 0;
  for (const line of lines) {
    if (/^\s{0,3}[-*_]{3,}\s*$/.test(line) && headings[hIdx]) {
      // was a heading underline in the original — replace the rule with bold title
      withBold.push(`**${headings[hIdx]}**`);
      hIdx += 1;
      continue;
    }
    withBold.push(line);
  }
  // Any headings we have not re-anchored are prepended as a bold block so the
  // information is not lost.
  const missing = headings.slice(hIdx);
  const body = [missing.map((h) => `**${h}**`).join("\n"), withBold.join("\n")].filter(Boolean).join("\n");
  const bolded = mapFenceAware(body, (line) => (isSectionLabel(line) ? `**${line.trim()}**` : line));
  const tableFree = bolded;
  const tableAware = (() => {
    const ls = tableFree.split("\n");
    const out: string[] = [];
    let i = 0;
    let inFence = false;
    while (i < ls.length) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(ls[i])) inFence = !inFence;
      if (!inFence && ls[i].includes("|") && ls[i + 1] !== undefined && isTableDelimiter(ls[i + 1])) {
        let end = i + 1;
        while (end + 1 < ls.length && ls[end + 1].includes("|")) end += 1;
        out.push(...flattenTable(ls, i, end));
        i = end + 1;
        continue;
      }
      out.push(ls[i]);
      i += 1;
    }
    return out.join("\n");
  })();

  const result = tableAware.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: result,
    transformed: result !== text.trim(),
    note: `discord: ${headings.length} heading(s) as bold, tables flattened, ${before} url(s) kept`,
  };
}

function renderSlack(text: string): RenderResult {
  const before = countUrls(text);
  const { text: noHeadings, headings } = dropHeadings(text);
  // Slack bold is a SINGLE asterisk and must not wrap whole paragraphs.
  const body = mapFenceAware(noHeadings, (line) => (isSectionLabel(line) ? `*${line.trim()}*` : line)).replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    "<$2|$1>",
  );
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) inFence = !inFence;
    if (!inFence && lines[i].includes("|") && lines[i + 1] !== undefined && isTableDelimiter(lines[i + 1])) {
      let end = i + 1;
      while (end + 1 < lines.length && lines[end + 1].includes("|")) end += 1;
      out.push(...flattenTable(lines, i, end));
      i = end + 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  const joined = out.join("\n");
  // Re-anchor headings: Slack has no headings, so they become bold label lines.
  const headBlock = headings.map((h) => `*${h}*`).join("\n");
  const result = [headBlock, joined].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: result,
    transformed: result !== text.trim(),
    note: `slack: mrkdwn single-asterisk, ${before} url(s) as <url|label>, ${headings.length} heading(s) bold`,
  };
}

/** Render for a channel. Never throws; unknown channels pass through. */
export function renderForChannel(text: string, channel: FormatChannel = "chat"): RenderResult {
  const src = text ?? "";
  if (!src.trim()) return { text: src, transformed: false, note: "empty" };
  try {
    if (channel === "discord") {
      const out = renderDiscord(src);
      return countUrls(out.text) >= countUrls(src) ? out : { text: src, transformed: false, note: "discord render dropped a url — kept original" };
    }
    if (channel === "slack") {
      const out = renderSlack(src);
      return countUrls(out.text) >= countUrls(src) ? out : { text: src, transformed: false, note: "slack render dropped a url — kept original" };
    }
    return { text: src, transformed: false, note: "chat/plain passthrough" };
  } catch (err) {
    return { text: src, transformed: false, note: `render failed (${err instanceof Error ? err.message : "unknown"}) — kept original` };
  }
}