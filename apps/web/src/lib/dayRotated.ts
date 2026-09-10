// Imaginative-line rotation helper (Fase: Anti-repetition pass 2026-09-12).
//
// Every deterministic Mia confirmation/push that used to repeat one fixed line
// ("Sudah kuhapus reminder itu ya…", "Udah kupause dulu ya…") now rotates
// through a pool of Mia-style variants one per calendar day. Day-rotation (not
// Math.random) keeps it deterministic, so verify.ts can assert variety by
// patching Date.now — and so a restarted server doesn't reshuffle a line the
// user already saw today.

/** Pick the variant for "today"; `salt` lets two pools diverge on the same day. */
export function dayRotated<T>(arr: readonly T[], salt = 0): T {
  const len = arr.length;
  const day = Math.floor(Date.now() / 86400000) + salt;
  return arr[((day % len) + len) % len];
}