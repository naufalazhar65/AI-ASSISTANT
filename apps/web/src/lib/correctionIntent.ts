const CORRECTION_RE =
  /\b(salah|keliru|bukan (begitu|gitu)|koreksi|seharusnya|yang benar|yang betul|maksudku|maksud saya)\b/i;

export function detectCorrection(userText: string): { original: string; corrected: string } | null {
  if (!userText || !CORRECTION_RE.test(userText)) return null;
  const parts = userText.split(/,|—|—|\n/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { original: parts[0].slice(0, 200), corrected: parts.slice(1).join(", ").slice(0, 500) };
  }
  // fallback: whole text as corrected
  return { original: "", corrected: userText.trim().slice(0, 500) };
}
