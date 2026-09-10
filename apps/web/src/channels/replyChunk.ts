export const DISCORD_MAX = 2000;
export const TELEGRAM_MAX = 4096;

/** Split long replies into channel-safe chunks on newline boundaries when possible. */
export function chunkText(text: string, max: number): string[] {
  const safe = text ?? "";
  if (safe.length <= max) return [safe];
  const out: string[] = [];
  let remaining = safe;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) out.push(remaining);
  return out;
}