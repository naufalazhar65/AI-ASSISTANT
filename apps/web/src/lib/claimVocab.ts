/**
 * The verdict-vocabulary of the honesty guards, as DATA rather than as regex
 * literals buried in `agent.ts`.
 *
 * Why this module exists (2026-09-26): the confirmed-strength vocabulary was
 * rebuilt three times in one evening and each rebuild lost a word —
 * `terbukti`/`terkonfirmasi` once, `diverifikasi` never, and a grouping slip
 * turned `\bterkonfirm\w*\b` into a negation and silently disabled the guard for
 * the most common Indonesian confirmed-word. Every other test stayed green,
 * because they all happened to use `terverifikasi`.
 *
 * That is the failure mode of an open-ended language problem answered with a
 * hand-written list: the list is never checked against itself. Keeping the words
 * as data lets `claimVocab.test.ts` iterate EVERY one of them and assert the
 * guard actually fires, so a dropped word or a stray alternation becomes a test
 * failure instead of a production miss.
 *
 * Adding a word here is therefore cheap AND self-verifying: the meta-test fails
 * until the regex is taught the same word.
 *
 * Pure — no imports, no I/O.
 */

/** Nouns a verdict can attach to. `confirmed` only counts next to one of these. */
export const VERDICT_NOUNS = [
  "vulnerability",
  "vulnerabilities",
  "kerentanan",
  "celah",
  "exploit",
  "bug",
  "temuan",
  "finding",
  "findings",
  "sqli",
  "idor",
  "xss",
  "ssrf",
  "xxe",
  "csrf",
  "rce",
  "bola",
  "takeover",
  "auth bypass",
] as const;

/**
 * Words that assert a verdict is settled, on their own. Indonesian drops the
 * prefix constantly ("sudah diverifikasi", "sudah kita verifikasi"), which is
 * why `BARE_VERIFY_WORDS` exists separately rather than being folded in here.
 */
export const VERDICT_WORDS = [
  "verified",
  "proven",
  "reproduced",
  "diverifikasi",
  "terverifikasi",
  "memverifikasi",
  "memverifika",
  "terverifika",
  "membuktikan",
  "terbukti",
  "terkonfirmasi",
] as const;

/**
 * The prefix-dropped forms. These also appear as a NOUN ("perlu verifikasi
 * manual" is the prover outputs' own language), so they only count behind an
 * aspect marker. A representative word for the meta-test; the live pattern also
 * covers "terkonfirm…", "memverifika…", "memverifika…" and "verifikan".
 */
export const BARE_VERIFY_WORDS = ["keverifikasi", "everifikasi", "verifikasi", "verifikan"] as const;

/** "sudah" / "telah" … marks an action as completed rather than wanted. */
export const ASPECT_MARKERS = ["sudah", "telah", "udah", "berhasil", "kini", "masih"] as const;

/** A negator turns a claim into its honest opposite. */
export const NEGATORS = ["belum", "nggak", "gak", "tidak", "kurang"] as const;

/**
 * Words that make a following requirement ("perlu diverifikasi") instead of a
 * claim. Matched NEAR the verb, and clause-scoped by the caller.
 */
export const PENDING_WORDS = [
  "perlu",
  "butuh",
  "harus",
  "mau",
  "ingin",
  "akan",
  "sebaiknya",
  "seharusnya",
  "bisa",
  "boleh",
  "dapat",
  "jangan",
] as const;

/**
 * Attributions of past work. Historically these silenced the verification guard
 * unconditionally — which meant a model could switch any guard off by saying
 * "sebelumnya". `claimAudit.ts` now checks the underlying FACT before letting
 * them pass; this list stays as the fallback when the fact is unknown.
 */
export const TIME_ATTRIBUTIONS = [
  "sebelumnya",
  "td lalu",
  "tadi lalu",
  "turn lalu",
  "run lalu",
  "waktu lalu",
  "minggu lalu",
  "kemarin",
  "pertama kali",
  "saat itu",
] as const;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Escape a word list into an alternation body. */
export const alt = (words: readonly string[]): string => words.map(esc).join("|");

/** `\b(?:…)\b` over a word list. */
export const wordAlt = (words: readonly string[]): string => `\\b(?:${alt(words)})\\b`;

/**
 * Security vocabulary gate. A "confirmed" in a non-security sentence — a
 * reminder, a weather line, a delivery receipt — must never read as a security
 * verdict. Two entries keep their flexible spacing (`cache dec`, `auth bypass`
 * appear both hyphenated and spaced in real output).
 */
export const SECURITY_VOCAB_RE = new RegExp(
  wordAlt([
    "csrf",
    "xss",
    "idor",
    "sqli",
    "injection",
    "ssrf",
    "xxe",
    "smuggl",
    "redirect",
    "pollut",
    "race",
    "bypass",
    "cache-decep",
    "cache dec",
    "cache-dec",
    "nosql",
    "auth-bypass",
    "auth bypass",
    "auth-bypass",
    "graphql",
    "otp",
    "takeover",
    "exposure",
    "upload",
  ]) + "|vulnerab\\w*|kerentanan",
  "i",
);

/** A settled-verdict claim on its own (`terbukti`, `verified`, `proven`, …). */
export const VERDICT_WORD_RE = new RegExp(
  `${wordAlt(VERDICT_WORDS)}|\\bterkonfirm\\w*\\b|\\bmemverifik\\w*\\b|\\bterverifik\\w*\\b`,
  "i",
);

/** Any verification verb, participled or not — used by the negation window. */
export const VERIFY_ANY_RE = new RegExp(
  wordAlt([
    "diverifikasi",
    "terverifikasi",
    "memverifikasi",
    "memverifika",
    "terverifika",
    "membuktikan",
    ...BARE_VERIFY_WORDS,
  ]),
  "i",
);

/** The prefix-dropped subset, which needs an aspect marker in front of it. */
export const BARE_VERIFY_RE = new RegExp(wordAlt(BARE_VERIFY_WORDS), "i");

/** Aspect marker within a short window before a bare verb. */
export const ASPECT_THEN_VERIFY_RE = new RegExp(
  `${wordAlt(ASPECT_MARKERS)}[\\s\\S]{0,24}?${BARE_VERIFY_RE.source}`,
  "i",
);

/** A requirement near a verb, e.g. "perlu diverifikasi". */
export const PENDING_NEAR_VERIFY_RE = new RegExp(
  `${wordAlt(PENDING_WORDS)}[^.!?]{0,30}?${VERIFY_ANY_RE.source}`,
  "i",
);

/**
 * A negator within a bounded window before a verification word.
 *
 * GROUPING IS LOAD-BEARING. The `terbukti` / `terkonfirmasi` alternatives must
 * stay INSIDE the non-capturing group after the window. Written as three
 * top-level alternatives, `\bterkonfirm\w*\b` becomes a "negation" of its own:
 * every "terkonfirmasi" claim matches it, so the guard silently declined to act
 * on the most common Indonesian confirmed-word while 13 other tests stayed green
 * (they all used `terverifikasi`).
 *
 * That bug happened twice: once in `agent.ts`, and then again — unchanged — in
 * this file, when the pattern was moved here. It was caught both times by tests
 * that iterate this vocabulary rather than by tests that pick a word. The
 * `it.each([...VERDICT_WORDS])` block in `claimVocab.test.ts` is the reason it
 * cannot survive a third time; if you add an alternative here, add its word to
 * the corresponding list.
 *
 * Trade-off (documented on the caller too): the window also silences a genuine
 * claim that sits close after a negator in the same sentence. A miss is the
 * right side to err on — this layer exists so honest work is not called a lie.
 */
export const NEGATOR_NEAR_VERIFY_RE = new RegExp(
  `${wordAlt(NEGATORS)}[^.!?]{0,40}?(?:${VERIFY_ANY_RE.source}|\\bterbukti\\b|\\bterkonfirm\\w*\\b)`,
  "i",
);

/** Past-work attribution. */
export const TIME_ATTRIBUTION_RE = new RegExp(`\\b(?:${alt(TIME_ATTRIBUTIONS)})\\b`, "i");

/** `confirmed` only reads as a verdict next to a verdict noun. */
export const CONFIRMED_VERDICT_RE = new RegExp(
  `${wordAlt(VERDICT_NOUNS)}\\s+(?:is\\s+|are\\s+)?confirmed|confirmed\\s+(?:the\\s+|a\\s+|an\\s+)?${wordAlt(VERDICT_NOUNS)}`,
  "i",
);
