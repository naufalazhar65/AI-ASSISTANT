/**
 * Fact lookup for narration claims (2026-09-26).
 *
 * The honesty guards used to decide truth by matching prose, which cannot work:
 * the model's vocabulary is open-ended and ours is a finite list, so every fix
 * added a word and every fix was beaten by the next live turn. Four bugs inside
 * a single fix on the same evening, one of which disabled a guard for the most
 * common Indonesian confirmed-word while 13 tests stayed green.
 *
 * This module replaces the guessing for the claim types where ground truth
 * actually exists in the process. `coverage` and `target_brain` are already
 * maintained, per target, by the recon tools and the auto-write hooks — they
 * were the fact base for "did we actually test this?" and no guard consulted
 * them. Now one does.
 *
 * Three rules, in order of importance:
 *
 *  1. A claim about the PAST ("sudah kupentest sebelumnya", "terverifikasi
 *     sebelumnya") was previously silenced by the mere PRESENCE of the word
 *     "sebelumnya" — meaning a model could switch any guard off by writing it.
 *     Now the underlying fact is checked, and a past-work claim is only
 *     believed when proving work for that host is actually on record.
 *
 *  2. Absent a fact, stay silent. `null` means "cannot tell", which must never
 *     be treated as false — accusing honest work is the worse error, and the
 *     whole layer exists to prevent it.
 *
 *  3. Reads are never invented. Everything here is derived from stores the
 *     agent itself populated; nothing is inferred from the model's prose.
 *
 * Pure: every reader is injected, so this is testable without disk and without
 * the network.
 */

/** A tool that can settle a finding, as opposed to one that only suspects it. */
export const PROVING_TOOLS = [
  "poc_verify",
  "retest_run",
  "dom_xss_prove",
  "csrf_prove",
  "smuggle_probe",
  "bypass403",
  "nosql_hunt",
  "path_traversal",
  "ssti_enum",
  "xxe_chain",
  "open_redirect_chain",
  "cache_poison_prover",
  "cache_decep",
  "bola_diff",
  "auth_matrix",
  "oast_poll",
  "oast_dns_poll",
  "ato_prove",
  "exploit_chain",
  "workflow_fuzz",
  "race_attack",
  "graphql_hunt",
  "ws_hunt",
  "otp_hunt",
  "account_recovery",
  "csv_inject",
  "blind_cmdi",
  "blind_ssrf",
  "otp_probe",
  "mcp_hunt",
  "llm_hunt",
  "param_fuzz",
  "js_deobfuscate",
] as const;

/** Proving tools the auto-approval policy can fire without a human. */
export const PROVING_TOOLS_SET: ReadonlySet<string> = new Set(PROVING_TOOLS as readonly string[]);

export interface AuditFacts {
  /** Host the claim is about, normalised (lowercased, no scheme/path). */
  host: string;
  /** Proving work recorded for this host at any point. `null` = unknown. */
  pastWorkProven: boolean | null;
  /** How many distinct proving runs, so a note can be specific. */
  provingRuns: number;
  /** Endpoints known for this host, and how many were actually probed. */
  endpointsSeen: number;
  endpointsProbed: number;
  /** Finding ids that carry their own proof (poc record / expected-actual). */
  verifiedFindingIds: readonly string[];
  /** Open findings on record for this host, and how many of them have proof. */
  findingsTotal: number;
  findingsWithProof: number;
  /** Findings the model named in this reply, resolvable in the store. */
  referencedFindingIds: readonly string[];
}

/** Reads the agent injects. Every one of them can fail closed to `null`. */
export interface AuditReaders {
  /** Proving runs ever recorded for a host, from the append-only audit log. */
  provingRunsForHost?: (host: string) => { count: number } | null;
  /** Endpoint coverage for a host, from the coverage ledger / target brain. */
  endpointCoverageForHost?: (host: string) => { seen: number; probed: number } | null;
  /**
   * Findings that carry proof, scoped to a host.
   *
   * Host-scoped on purpose: the first version returned every proven finding of
   * the user while the total was host-filtered, and the note printed "7 temuan
   * terbuka, 9 yang punya bukti" — nonsense. Both counts must describe the SAME
   * set or the sentence is worse than no sentence.
   */
  verifiedFindingIds?: (host: string) => readonly string[] | null;
  /** Open findings on record, so a "verified" claim can be counted, not guessed. */
  openFindingIds?: (host: string) => readonly string[] | null;
}

const normaliseHost = (raw: string): string =>
  String(raw || "")
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");

/** Does this reply name a finding id we can resolve? */
export function referencedFindingIds(text: string): string[] {
  const t = String(text || "");
  const out = new Set<string>();
  // Store ids look like F-mu5c2qwm; a title match alone is too weak to assert on.
  for (const m of t.matchAll(/\bF-[a-z0-9]{4,12}\b/gi)) out.add(m[0]);
  return [...out];
}

/**
 * Build the facts a guard needs. Any reader that throws or returns nothing
 * yields `null` for that field — "unknown", never "false".
 */
export function buildAuditFacts(
  host: string,
  readers: AuditReaders,
  text = ""
): AuditFacts {
  const h = normaliseHost(host);
  let pastWorkProven: boolean | null = null;
  let provingRuns = 0;
  if (readers.provingRunsForHost && h) {
    try {
      const r = readers.provingRunsForHost(h);
      if (r && typeof r.count === "number") {
        pastWorkProven = r.count > 0;
        provingRuns = r.count;
      }
    } catch {
      pastWorkProven = null;
    }
  }

  let endpointsSeen = 0;
  let endpointsProbed = 0;
  if (readers.endpointCoverageForHost && h) {
    try {
      const c = readers.endpointCoverageForHost(h);
      if (c && typeof c.seen === "number" && typeof c.probed === "number") {
        endpointsSeen = c.seen;
        endpointsProbed = c.probed;
      }
    } catch {
      /* unknown */
    }
  }

  let verifiedFindingIds: readonly string[] = [];
  if (readers.verifiedFindingIds && h) {
    try {
      verifiedFindingIds = readers.verifiedFindingIds(h) ?? [];
    } catch {
      verifiedFindingIds = [];
    }
  }

  // Open findings for this host. This is the ONE count that is essentially
  // always available (the findings store exists for any user who has done a
  // pentest), unlike endpoint coverage — which is inert until the brain hooks
  // and the coverage ledger are actually populated. With it, "the 7 findings are
  // verified" becomes countable: N on record, M of them with proof.
  let findingsTotal = 0;
  if (readers.openFindingIds && h) {
    try {
      findingsTotal = (readers.openFindingIds(h) ?? []).length;
    } catch {
      findingsTotal = 0;
    }
  }

  return {
    host: h,
    pastWorkProven,
    provingRuns,
    endpointsSeen,
    endpointsProbed,
    verifiedFindingIds,
    findingsTotal,
    findingsWithProof: verifiedFindingIds.length,
    referencedFindingIds: referencedFindingIds(text),
  };
}

/**
 * Signals for an EXHAUSTIVE testing claim.
 *
 * Split into two independent halves because the live sentence orders them the
 * other way round from what a single pattern would expect:
 *
 *   "Semua endpoint utama juga sudah aku cek berulang supaya hasilnya konsisten"
 *
 * — quantifier FIRST, completion verb LAST. A pattern shaped as
 * "sudah … cek … semua" does not match this, and that is exactly how the claim
 * slipped through on 2026-09-26: no number for the numeric guard, and no
 * keyword pattern for anything else.
 */
const EXHAUSTIVE_QUANTIFIER =
  /\b(?:semua|seluruh|all|every)\b[^.!?]{0,40}?\b(?:endpoint|endpoints|path|paths|route|routes|halaman)\b|\b(?:endpoint|endpoints|path|paths|route|routes|halaman)\b[^.!?]{0,24}?\b(?:semua|seluruh|all|every)\b|\bmenyeluruh\b/i;
const COMPLETION_VERB =
  /\b(?:sudah|udah|telah|berhasil|kalian?)\b[^.!?]{0,24}?\b(?:kucek|cek|uji|tes|test|scan|periksa|audit|hunt|nyoba|coba)\b/i;
/**
 * "Selesai" with no testing verb at all, as a completion signal.
 *
 * Live 2026-09-27 01:14: "pentest menyeluruh untuk target tersebut udah aku
 * tuntasin" after probing ONE of seven known endpoints. Neither guard caught it —
 * COMPLETION_VERB needs a testing verb, and "tuntasin" is the colloquial -in
 * form behind a pronoun ("udah aku …"), so no adjacency either.
 *
 * The result clause stays mandatory: "udah aku tuntasin ya, makasih" is
 * ordinary speech and must stay silent.
 */
const COMPLETION_BARE =
  /\b(?:sudah|udah|lah)\s+(?:aku|ku|saya|kita|kami)?\s*(?:lengkap|selesai|selesain|selesaikan|beres|beresin|tuntas|tuntasin|rapi|mantap)(?:in|kan|i)?\b/i;

/**
 * A completion claim about testing EVERY endpoint, checked against coverage.
 *
 * Silent when coverage is unknown, when everything known was actually probed,
 * or when the model used honest framing ("yang bisa kujangkau").
 */
export function untestedSurfaceClaimNote(text: string, facts: AuditFacts): string {
  // Sentence-scoped: a quantifier in one sentence and a completion verb in
  // another do not make an exhaustive claim.
  for (const sentence of String(text || "").split(/[.!?\n]/)) {
    if (!EXHAUSTIVE_QUANTIFIER.test(sentence)) continue;
    if (!COMPLETION_VERB.test(sentence) && !COMPLETION_BARE.test(sentence)) continue;
    if (!facts.endpointsSeen || facts.endpointsProbed >= facts.endpointsSeen) continue;
    const gap = facts.endpointsSeen - facts.endpointsProbed;
    return ` (Catatan jujur: dari ${facts.endpointsSeen} endpoint yang tercatat untuk ${facts.host || "target ini"}, yang benar-benar diprobes cuma ${facts.endpointsProbed} — ${gap} endpoint belum ada request-nya. Jangan sebut "semua sudah dicek" sebelum gapnya keuji.)`;
  }
  return "";
}

/**
 * A past-work claim with no proving work on record.
 *
 * This is the case the keyword approach got backwards: "sebelumnya" used to
 * silence the guard unconditionally, so adding the word was enough to switch
 * every guard off. Here the claim is only believed when the audit log actually
 * holds proving runs for that host.
 */
export function unprovenPastWorkClaimNote(text: string, facts: AuditFacts): string {
  const t = String(text || "");
  if (facts.pastWorkProven !== false) return "";
  // Only about PAST work, and only a settled claim that it was real testing.
  const pastWork =
    /\b(?:sebelumnya|td\s+lalu|tadi\s+lalu|turn\s+lalu|run\s+lalu|waktu\s+lalu|minggu\s+lalu|kemarin|pertama\s+kali|saat\s+itu)\b/i.test(t);
  if (!pastWork) return "";
  // Prefix attachment, not a word boundary.
  //
  // `\bpentest\b` never matches "kupentest" — "u" and "p" are both word
  // characters, so there is no boundary between them. The same class of bug as
  // the mood detector reading "markdown" as `sad` (2026-07): Indonesian attaches
  // its prefixes directly (kupentest, kujalankan, kucek), so the leading `\b` has
  // to go while the trailing one keeps the match from firing inside a longer word
  // ("testing" must not satisfy "tes").
  const claimsTesting = /\b\w*(?:pentest|uji|tes|scan|hunt|audit|verifikasi|terverifikasi|cek)\b/i.test(t);
  if (!claimsTesting) return "";
  return " (Catatan jujur: tidak ada satu pun catatan pengujian di target ini sebelumnya — audit log kosong untuk host itu, jadi klaim \"sudah kupentest sebelumnya\" tidak punya bukti. Kalau memang pernah, sebut turn-nya biar bisa kucocokkan.)";
}
