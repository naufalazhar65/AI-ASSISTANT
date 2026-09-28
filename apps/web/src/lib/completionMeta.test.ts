// GENERATIVE meta-test for the completion-claim trigger.
//
// Why this file exists, in the repo's own words: three separate live turns died
// on the SHAPE of a sentence, not on the meaning —
//   · 2026-09-07  the unanchored keyword `down` matched inside "markdown",
//   · 2026-09-25  "pengujian menyeluruh … sudah selesai" hid behind a modifier,
//   · 2026-09-28  the refusal noun sat 55 chars out, outside a 45-char window.
// Each fix patched one instance and the class stayed alive. So the guard's
// VOCABULARY is exported as data, and this file iterates EVERY term and every
// PAIR of terms. A grouping mistake — an alternation alternative that silently
// swallows its siblings, the bug that cost four fixes in twenty minutes — cannot
// be introduced without turning one of these red.
//
// The other half matters just as much: a trigger that fires on everything is not
// a fix, it is noise. SILENT_CLAIMS below is curated to be ordinary speech, and
// every entry must stay silent.

import { describe, expect, it } from "vitest";
import {
  ASPECT_MARKERS,
  SEALED_WORDS,
  TESTING_NOUNS,
  TESTING_VERBS,
  claimsTestingConcluded,
  hasCompletionClaim,
  hasResultCompletionClaim,
} from "./agent";

/** Sentences that name testing work but assert NOTHING about it concluding. */
const SILENT_CLAIMS: readonly string[] = [
  "Aku menjalankan pengujian keamanan seperti biasa.",
  "pemindaian kerentanan selesai, 3 temuan tercatat.",
  "Hasil pengujian menunjukkan tidak ada masalah di sana.",
  "Pengujian keamanan berjalan setiap malam.",
  "Aku akan melakukan pengujian besok pagi.",
  "Target pengujiannya adalah lab itu, kan?",
  "Pengujian penetration di lab sudahDiscovery servernya dulu.",
  "Tesimonialmu soal pengujian itu bagus.",
  "Pengujian yang kukejutkan: error 500 terus.",
  "Completezza del rapporto in PDF.",
  "Done reading the report you sent.",
  "Finished reading it — 7 findings noted.",
  "I've completed the report you asked for.",
  "Testing the waters is not pentesting, correct?",
  "Maaf ya, pengujiannya belum selesai, aku lanjutkan dulu.",
  "Pengujian belum sepenuhnya tuntas, masih ada 2 endpoint yang belum dicek.",
  "Kalau pengujian sudah selesai semua, baru aku laporkan.",
  "Aku tidak sudah menguji endpoint itu.",
  "Audit trail-nya belum lengkap.",
  "Hasil pengujiannya belum keluar.",
];

describe("completion trigger — every exported term fires (generative)", () => {
  it("every testing NOUN, with a sealed word, in one sentence, claims completion", () => {
    for (const noun of TESTING_NOUNS) {
      const s = `${noun} untuk target itu sudah selesai`;
      expect(hasCompletionClaim(s), `noun "${noun}" did not fire: ${s}`).toBe(true);
    }
  });

  it("every testing NOUN also fires with the noun AFTER the sealed word (word order is free)", () => {
    for (const noun of TESTING_NOUNS) {
      const s = `sudah selesai ${noun} di target itu`;
      expect(hasCompletionClaim(s), `noun "${noun}" (reversed) did not fire: ${s}`).toBe(true);
    }
  });

  it("every testing VERB fires on its own, with no noun present", () => {
    for (const verb of TESTING_VERBS) {
      const s = `sudah aku ${verb} endpoint itu tadi`;
      expect(hasCompletionClaim(s), `verb "${verb}" did not fire: ${s}`).toBe(true);
    }
  });

  it("every SEALED word fires against one fixed testing noun", () => {
    for (const sealed of SEALED_WORDS) {
      const s = `pentest di lab itu sudah ${sealed}`;
      expect(hasCompletionClaim(s), `sealed "${sealed}" did not fire: ${s}`).toBe(true);
    }
  });

  it("every ASPECT marker fires against one fixed testing noun", () => {
    for (const marker of ASPECT_MARKERS) {
      const s = `${marker} menguji seluruh endpoint di lab itu`;
      expect(hasCompletionClaim(s), `aspect "${marker}" did not fire: ${s}`).toBe(true);
    }
  });

  it("no distance window: a very long modifier between the two words still fires", () => {
    const long = `pentest untuk situs yang kebetulan punya nama domain yang sangat panjang sekali di lab owner ${"x".repeat(200)} sudah selesai`;
    expect(hasCompletionClaim(long)).toBe(true);
  });

  it("GROUPING property: no term is shadowed by another term in the same sentence", () => {
    // The 2026-09-27 bug: an alternation written so one alternative matched on
    // its own and disabled the guard for its siblings. Every term must keep
    // working while every OTHER term sits in the same sentence.
    const all = [...TESTING_NOUNS, ...TESTING_VERBS, ...SEALED_WORDS, ...ASPECT_MARKERS];
    for (const keep of all) {
      for (const other of all) {
        if (other === keep) continue;
        const s = `pentest ${other} ${keep} di target itu`;
        if (!hasCompletionClaim(s)) {
          // Only a failure if the sentence actually contains the trigger pair;
          // an arbitrary pair may legitimately lack a sealed word.
          if (SEALED_WORDS.includes(keep) || ASPECT_MARKERS.includes(keep)) {
            expect(
              hasCompletionClaim(s),
              `"${keep}" was shadowed when "${other}" was also present: ${s}`
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("completion trigger — honest speech stays silent (the other half)", () => {
  it("every curated non-claim stays silent", () => {
    for (const s of SILENT_CLAIMS) {
      expect(claimsTestingConcluded(s), `false accusation on ordinary speech: ${s}`).toBe(false);
    }
  });

  it("a question is the owner asking, not the model claiming", () => {
    expect(hasCompletionClaim("Sudah selesai pengujiannya?")).toBe(false);
    expect(hasCompletionClaim("Pentest-nya sudah selesai?")).toBe(false);
  });

  it("an honest admission is never accused", () => {
    expect(hasCompletionClaim("Maaf ya, pengujiannya belum selesai, aku lanjutkan dulu.")).toBe(false);
    expect(hasCompletionClaim("Audit trail-nya belum lengkap.")).toBe(false);
  });

  it("a conditional is not a claim", () => {
    expect(hasCompletionClaim("Kalau pengujian sudah selesai semua, baru aku laporkan.")).toBe(false);
  });
});

describe("result-gated tier — 'finished' with no testing word at all", () => {
  it("fires on the live 00:57 shape (finished + a result)", () => {
    expect(hasResultCompletionClaim("Udah lengkap ya Mas Naufal, ketemu tujuh celah.")).toBe(true);
  });

  it("does NOT fire on ordinary praise (no result clause)", () => {
    expect(hasResultCompletionClaim("Udah lengkap, terima kasih ya")).toBe(false);
    expect(hasResultCompletionClaim("Sudah rapi, akuoxane")).toBe(false);
  });

  it("'laporan lengkap' is not a completion claim — the report did finish", () => {
    // Live 13:44 said "laporannya lengkap dengan 7 temuan" over a turn that
    // produced a real report. Accusing that would be a false accusation.
    expect(hasResultCompletionClaim("laporannya lengkap dengan 7 temuan")).toBe(false);
    // …and the general tier must not catch it either (no testing word).
    expect(hasCompletionClaim("laporannya lengkap dengan 7 temuan")).toBe(false);
  });
});

describe("the live shapes this trigger was rebuilt for", () => {
  const LIVE_1318 =
    "Mas Naufal, full pentest untuk cozy-kangaroo udah tuntas dan laporannya lengkap dengan 7 temuan (2 critical, 3 high, 2 medium) termasuk SQLi, IDOR, Stored XSS, dan credential exposure.";
  const LIVE_0023 = "Aku sudah menguji seluruh endpoint di lab itu dan semuanya tuntas.";

  it("catches the live 13:18 prose (a target name between the noun and the copula)", () => {
    expect(hasCompletionClaim(LIVE_1318)).toBe(true);
  });

  it("catches the 02:23 prose", () => {
    expect(hasCompletionClaim(LIVE_0023)).toBe(true);
  });
});
