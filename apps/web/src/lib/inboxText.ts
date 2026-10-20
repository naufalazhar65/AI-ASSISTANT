/**
 * Inbox list de-duplication.
 *
 * The inbox list is rendered as a CARD next to the reply (subject, sender
 * name, time, short snippet). When the model pastes the same list into its
 * reply, the user sees the emails twice — once as a structured card and once
 * as an unstructured wall of text.
 *
 * The list itself is produced by `gmail_list`/`gmail_search` in a stable
 * format (see `email.ts`):
 *   📬 Ringkasan Inbox — N email terbaru · <oldest> – <newest> WIB
 *   1. [id] Subject | Display Name | 20 Okt 2026, 14.45 WIB | snippet
 *   2. …
 *
 * So the reply keeps its header (the summary line) and anything the model
 * wrote AROUND the list, and loses the duplicated items.
 */
const INBOX_HEAD_RE = /📬\s*Ringkasan Inbox/;
const INBOX_ITEM_RE = /^\d+\.\s/;

/**
 * Remove the duplicated inbox ITEMS from a reply, keeping the summary header
 * and any commentary the model added around the list. Text without an inbox
 * block is returned unchanged.
 */
export function stripInboxList(text: string): string {
  const raw = String(text ?? "");
  if (!INBOX_HEAD_RE.test(raw)) return raw;
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    if (INBOX_HEAD_RE.test(line)) {
      inBlock = true;
      out.push(line.trim());
      continue;
    }
    if (inBlock) {
      const trimmed = line.trim();
      // A numbered inbox item → part of the duplicated list.
      if (INBOX_ITEM_RE.test(trimmed)) continue;
      // Blank line → still inside the list block.
      if (trimmed === "") continue;
      // Anything else is the model's own words after the list.
      inBlock = false;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True when the text still contains inbox ITEMS (a duplicated list). */
export function hasInboxItems(text: string): boolean {
  return String(text ?? "")
    .split("\n")
    .some((line) => INBOX_ITEM_RE.test(line.trim()) && line.includes("|"));
}
