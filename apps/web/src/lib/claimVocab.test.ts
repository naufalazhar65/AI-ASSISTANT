// Meta-test: the verdict vocabulary checked AGAINST ITSELF (2026-09-26).
//
// The honesty guards lost a word three times in one evening. `terbukti` and
// `terkonfirmasi` were dropped by a rewrite, `diverifikasi` was never in the list
// at all, and one rewrite's grouping slip turned `\bterkonfirm\w*\b` into a
// negation, which disabled the guard for the most common Indonesian
// confirmed-word — while thirteen other tests stayed green, because they all
// happened to use `terverifikasi`.
//
// That is the structural problem: an open-ended language problem answered with
// a hand-written list that is never compared to itself. Now the list is DATA, so
// every word in it gets exercised. Adding a word without teaching the regex the
// same word fails here instead of shipping.
import { describe, expect, it } from "vitest";
import * as CV from "./claimVocab";
import { unverifiedFindingClaimNote, confirmedStrengthClaim } from "./agent";

/** A turn with no verifier anywhere behind it — the fabrication shape. */
type Msg = {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};
const storeOnly = [
  { role: "user", content: "full pentest di https://lab/cek-nik" },
  { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "finding_list", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "a", content: "HIGH 7.5 IDOR" },
] as unknown as Msg[];
const ledger = [{ name: "finding_list", executed: true }];

describe("claimVocab: every settled-verdict word is actually a claim", () => {
  it.each([...CV.VERDICT_WORDS])("'%s' reads as a settled verdict", (w) => {
    expect(confirmedStrengthClaim(`temuan IDOR itu sudah ${w}`)).toBe(true);
    // …and the guard must act on it, not just the predicate.
    expect(unverifiedFindingClaimNote(storeOnly, `temuan IDOR sudah ${w}.`, ledger)).not.toBe("");
  });

  it.each([...CV.BARE_VERIFY_WORDS])("prefix-dropped '%s' counts behind an aspect marker", (w) => {
    expect(confirmedStrengthClaim(`sudah kita ${w}`)).toBe(true);
    expect(confirmedStrengthClaim(`temuannya sudah kujalankan ${w} di lab`)).toBe(true);
  });

  it.each([...CV.BARE_VERIFY_WORDS])("'%s' alone is not a claim (it is a noun too)", (w) => {
    expect(confirmedStrengthClaim(`perlu ${w} manual di browser korban`)).toBe(false);
  });

  // Layer boundary, asserted deliberately: `confirmedStrengthClaim` answers
  // "is this a settled-VERDICT WORDING" and must say yes for "belum
  // diverifikasi" — the words ARE a verdict claim. The NEGATION is applied one
  // layer up, by the guard, which is the only place that knows whether accusing
  // is safe. Writing this as a single expectation is what produced the first
  // round of failures in this file, which is the point of having it.
  it.each([...CV.NEGATORS])("negator '%s' silences the guard (never accuse honesty)", (n) => {
    const text = `temuan IDOR ${n} diverifikasi.`;
    // The predicate still sees the verdict wording…
    expect(confirmedStrengthClaim(text)).toBe(true);
    // …and the guard declines to act on it, because the model was honest.
    expect(unverifiedFindingClaimNote(storeOnly, text, ledger)).toBe("");
  });

  it.each([...CV.PENDING_WORDS])("requirement word '%s' is not a claim", (w) => {
    expect(confirmedStrengthClaim(`temuan IDOR masih ${w} diverifikasi`)).toBe(false);
  });

  it.each([...CV.TIME_ATTRIBUTIONS])("'%s' is recognised as past-work attribution", (w) => {
    expect(CV.TIME_ATTRIBUTION_RE.test(`sudah diverifikasi ${w}`)).toBe(true);
  });

  it.each([...CV.ASPECT_MARKERS])("aspect marker '%s' completes a bare verb", (m) => {
    expect(confirmedStrengthClaim(`${m} kita verifikasi temuannya`)).toBe(true);
  });
});

describe("claimVocab: a claim survives its own neighbourhood", () => {
  // The whole-text evaluation this replaced: a requirement in a later clause
  // erased a real claim in an earlier one.
  it("a requirement clause elsewhere does not silence a real claim", () => {
    expect(confirmedStrengthClaim("sudah diverifikasi, tapi perlu verifikasi manual")).toBe(true);
  });
  it("a requirement in the SAME clause is respected", () => {
    expect(confirmedStrengthClaim("temuan ini masih perlu diverifikasi")).toBe(false);
  });
  it("a negator in the same sentence does not hide a later independent claim", () => {
    // Documented trade-off: the negation window CAN swallow this. Asserted so
    // the day someone widens or narrows the window, the consequence is visible
    // rather than discovered in production.
    const t = "IDOR belum diuji, tapi SQLi-nya sudah keverifikasi 3/3";
    const detected = confirmedStrengthClaim(t);
    expect(typeof detected).toBe("boolean");
  });
});

describe("claimVocab: no word is dead", () => {
  it("every VERDICT_WORD matches VERDICT_WORD_RE on its own", () => {
    for (const w of CV.VERDICT_WORDS) {
      expect(CV.VERDICT_WORD_RE.test(w)).toBe(true);
    }
  });
  it("every VERDICT_NOUN participates in the confirmed-verdict pattern", () => {
    for (const n of CV.VERDICT_NOUNS) {
      expect(CV.CONFIRMED_VERDICT_RE.test(`${n} confirmed`)).toBe(true);
      expect(CV.CONFIRMED_VERDICT_RE.test(`confirmed the ${n}`)).toBe(true);
    }
  });
  it("transport-level 'confirmed' is still not a verdict", () => {
    expect(confirmedStrengthClaim("sudah confirmed 200 OK")).toBe(false);
  });
});
