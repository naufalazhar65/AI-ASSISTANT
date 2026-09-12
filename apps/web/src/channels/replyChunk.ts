export const DISCORD_MAX = 2000;
export const TELEGRAM_MAX = 4096;

/** Short interim "waiting" lines shown right after a risky-tool confirmation
 *  ("balas ya") before the follow-up turn runs — varied so repeated confirms
 *  don't echo the same sentence every time. */
const INTERIM_WAITS = [
  "Oke, sebentar ya…",
  "Bentar, lagi kuproses…",
  "Siap, tungguin dulu ya…",
  "Oke, nggak lama kok…",
  "Oke-oke, dikerjain dulu ya…",
  "Bentar, kupastikan dulu ini aman ya…",
];

export function interimWaitText(): string {
  return INTERIM_WAITS[Math.floor(Math.random() * INTERIM_WAITS.length)] ?? "Oke, sebentar ya…";
}

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