/**
 * Deterministic detection of "delete completed/cancelled tasks" intent.
 *
 * The model (especially smaller/free-tier ones) confuses "hapus yang udah kelar"
 * (delete completed) with "complete_task" (mark as done). This detector runs
 * the deterministic path so the store is actually cleaned up regardless of
 * whether the model called the right tool.
 */

const CLEAR_COMPLETED_RE = /\b(hapus|delete|clear|bersihkan|buang|remove)\b.*\b(kelar|selesai|done|completed|batal|cancelled)\b/i;
const CLEAR_COMPLETED_RE2 = /\b(kelar|selesai|done|completed|batal|cancelled)\b.*\b(hapus|delete|clear|bersihkan|buang|remove)\b/i;

/** True if the user's message asks to delete/remove completed or cancelled tasks. */
export function detectClearCompletedIntent(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  // Must contain BOTH a delete verb AND a "completed/cancelled" qualifier.
  return CLEAR_COMPLETED_RE.test(t) || CLEAR_COMPLETED_RE2.test(t);
}

/** True if the user's message asks to delete a specific task. */
export function detectDeleteTaskIntent(text: string): { match: string } | null {
  const t = (text || "").trim();
  const m = t.match(/\b(?:hapus|delete|buang|remove)\s+(?:tugas\s+)?(.+?)(?:\s*$|\s*[.!?])/i);
  if (!m) return null;
  const candidate = m[1].trim();
  if (!candidate || candidate.length < 2) return null;
  // Exclude "yang udah kelar" / "yang selesai" / "completed" — those are clear_completed
  if (/^(yang\s+)?(udah\s+)?(kelar|selesai|done|completed|batal|cancelled|semua)$/i.test(candidate)) return null;
  return { match: candidate };
}