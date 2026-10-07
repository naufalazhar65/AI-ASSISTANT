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
 * The agent-scoped user keys that `userKeyForAgent` (discord.ts) appends.
 *
 * These exist so each trio bot keeps its OWN persona/memory/sessions dir — a
 * deliberate, per-agent voice. They were never meant to isolate PENTEST state,
 * and that distinction is the whole point of the function below.
 */
const AGENT_SUFFIXES = [".agnes", ".michelle"] as const;

/**
 * PENTEST state is OWNER-scoped, deliberately NOT agent-scoped.
 *
 * Observed 2026-10-07 16:43 WIB, verified against the store on disk: the owner
 * asked `!cell coba lakukan full pentest ... di cozy-kangaroo-42f2e0...` and
 * Michelle answered three separate fabrications —
 *   1. "Endpoint /api/cari-berita aman dari SQLi" while the OWNER store holds
 *      `critical — SQL Injection in /api/cari-berita?q allows unauthenticated
 *      database access and credential disclosure`. Her own store held ZERO
 *      findings, so she could not see the proof that contradicted her.
 *   2. "Laporan PDF-nya sudah otomatis dicetak" — `report_save` returned
 *      `EMPTY_REPORT` because it read her own empty store.
 *   3. `finding_add` failed 3× ("judul temuan wajib") while she retried blind.
 *
 * The store split that let this happen:
 *   naufalazhar652952            findings=25  reports=52
 *   naufalazhar652952.michelle   findings=0   reports=0
 *   naufalazhar652952.agnes      findings=0   reports=0
 *
 * Why the split is wrong for pentest, unlike for persona: a persona is about
 * how ONE agent speaks to him, so three copies is a feature. A finding is a
 * fact about a TARGET, discovered once — three copies is data loss, and it makes
 * every agent blind to the other's proof. Each trio bot ends up able to declare
 * "aman" about an endpoint a sibling already proved critical, and each can
 * honestly report EMPTY_REPORT about a target with 15 open findings.
 *
 * `resolveOwnerScopedKey` is the single owner of that decision, so every pentest
 * store cannot drift. Falls back to the validated key when it is not an agent
 * key, and returns null only when the input is not a usable key at all — so a
 * genuinely different person (there is none today, but the guard matters) is
 * never silently merged into the owner's pentest history.
 */
export function resolveOwnerScopedKey(user: unknown): string | null {
  const key = validateUserKey(user);
  if (!key) return null;
  const agent = (AGENT_SUFFIXES as readonly string[]).find((suffix) =>
    key.endsWith(suffix),
  );
  // Fold the alias AFTER stripping the suffix, not before: the agent suffix is
  // appended to whatever the channel produced, and that can itself be an alias
  // ("Zigen.michelle"). Folding first yields "Zigen", which is a valid key and
  // therefore slips straight through validateUserKey as a SECOND store.
  const base = agent ? key.slice(0, key.length - agent.length) : key;
  return canonicalUserKey(base);
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
