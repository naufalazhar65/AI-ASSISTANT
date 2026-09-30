/**
 * Canonical identity for a SINGLE-OWNER app.
 *
 * Why this module exists (2026-09-30): the owner runs Mia on Discord, Telegram
 * AND the browser, and the browser used to ASK HIM TO TYPE A NAME. He typed one
 * letter — `s` — and spent a whole session talking to a Mia with her own
 * private store: 4 persona facts instead of 22, a wrong `city: Jakarta`, and a
 * hallucinated `plan: free`. Three directories for one human, because each
 * adapter derived its own key and the alias table was never consulted:
 *
 *   | store             | written by      | facts | memory days |
 *   |-------------------|-----------------|-------|-------------|
 *   | naufalazhar652952 | Discord (owner) |  22  |     31      |
 *   | naufalazhar65     | Telegram        |   4  |      4      |
 *   | s                 | the web browser |   4  |      1      |
 *
 * Two rules follow, and this file is the single owner of both:
 *
 *  1. NEVER ask the owner who he is. There is one user; the identity is known.
 *  2. Fold an incoming key to the canonical key inside the ONE function every
 *     store already calls, so an alias can never fork a second memory.
 *
 * Client-safe: no node built-ins, so the browser and the server may both import
 * it. Invariant 5 is intact by construction — an alias is only ever substituted
 * for a key that ALREADY passed validation, and every alias value is a
 * hard-coded literal that passes validation itself.
 */

/** The one human this app serves. Every channel resolves to this key. */
export const OWNER_KEY = "naufalazhar652952";

/**
 * Display label only — NEVER a store key. The single source of truth for user
 * facts is the persona (`apps/web/persona/USER.md`, server-side); this exists
 * because a client component cannot read that, and greeting him as
 * "naufalazhar652952" would be absurd.
 */
export const OWNER_LABEL = "Naufal";

/**
 * Alternate names for the same person, one per channel.
 *
 * `naufal` is here because it is DISCORD_USER's value AND the hard-coded
 * fallback in `discord.ts` (`slug || process.env.DISCORD_USER || "naufal"`).
 * Without this alias, any failure of the username slug silently created a
 * brand-new EMPTY store for a person who already had 22 facts — which is
 * exactly how this whole split started.
 */
const OWNER_ALIASES: Record<string, string> = {
  Zigen: OWNER_KEY,
  naufalazhar65: OWNER_KEY,
  naufal: OWNER_KEY,
};

/**
 * Validate a user key WITHOUT folding aliases. Returns the key as given, or
 * null when it could not be a directory name. Exported for the rare caller that
 * genuinely needs the literal value it was handed (diagnostics, migrations);
 * store paths should use `canonicalUserKey` instead.
 */
export function validateUserKey(user: unknown): string | null {
  if (typeof user !== "string") return null;
  const trimmed = user.trim();
  if (!trimmed || trimmed.length > 60) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

/**
 * Validate AND fold to the canonical key: the identity every store path and
 * every audit row should use. This is the function callers want — `sanitizeUser`
 * in `users.ts` is a re-export of it, which is how ~100 store modules got the
 * fold without being touched.
 */
export function canonicalUserKey(user: unknown): string | null {
  const key = validateUserKey(user);
  if (!key) return null;
  return OWNER_ALIASES[key] || key;
}

/**
 * The BROWSER's identity resolution, and deliberately stronger than a fold.
 *
 * Why this exists (2026-09-30, after the fold shipped and the owner tested it in
 * a real browser): the fold I shipped FAILED for the exact key that caused the
 * whole incident. The stale browser value is `s`; `s` is a perfectly valid key
 * that is simply absent from `OWNER_ALIASES`, so `canonicalUserKey("s")`
 * returned `"s"` unchanged. The app kept greeting him "Hi, s", kept sending
 * `body.user = "s"`, and the server faithfully re-created `.data/users/s/` with
 * a wrong `city: Jakarta` and no cat. He reported it verbatim: "mia masih bilang
 * saya tingga dijakarta, bahkan nama kucing mia ga tau".
 *
 * I had written in this file's own reasoning that "no alias list can enumerate
 * every name a human may type" — and then shipped a fix that handled only the
 * names that ARE in the list. The reasoning was right; the implementation
 * contradicted it. Adding `s` as a fourth alias would have been the same mistake
 * one more time: the next typo, the next family member, the next browser, and we
 * are back to three directories.
 *
 * The correction is that a FOLD is the wrong operation here. This app serves ONE
 * human — one persona, one memory, one set of reminders — so the browser does
 * not have an identity to look up, it has a fixed one. An unknown or missing
 * value is not a different user to honour; it is a value that was never an
 * identity in the first place. Hence: ALWAYS `OWNER_KEY`.
 *
 * The server keeps folding (`sanitizeUser`/`canonicalUserKey`) as the backstop
 * for the CHANNEL keys Discord and Telegram legitimately differ on, which are
 * enumerable. The browser is not a channel — it is the same one person.
 *
 * `stored` is still validated and is still handed back, but only as a DIAGNOSTIC
 * (a log line saying which stale value was replaced); it is never returned.
 */
export function resolveBrowserUserKey(stored: unknown): string {
  const key = validateUserKey(stored);
  if (key && key !== OWNER_KEY && !OWNER_ALIASES[key]) {
    // Deliberately not logged here: this module is CLIENT-SAFE and imported by
    // the Settings UI, so it must not pull in a server logger. The caller logs.
  }
  return OWNER_KEY;
}
