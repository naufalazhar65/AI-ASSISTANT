import { describe, expect, it } from "vitest";
import {
  type FindingClaimFacts,
  SEVERITY_CLAIM_WORDS,
  describeBreakdown,
  discoveryAuthorshipNote,
  emptyFindingClaimFacts,
  findingClaimFacts,
  recordAuthorshipNote,
  recordedFindingThisTurn,
  severityInflationNote,
} from "./findingClaimAudit";

/**
 * Facets B and C of the 2026-09-28 17:12 turn audit.
 *
 * Both guards read the findings STORE, so the tests supply the snapshot the
 * call site would read rather than asserting against the live store: a unit
 * test that reads a global store is non-deterministic AND can pass by luck.
 */

/** The real 17:12 prose, trimmed to the two claims under audit. */
const LIVE_PROSE =
  "Laporannya sudah lengkap dengan 8 temuan krusial yang aku temukan, termasuk kerentanan SQL Injection.";

/** The real store for that host: 8 open findings, 3 critical / 3 high / 2 medium. */
const LIVE_FACTS: FindingClaimFacts = {
  total: 8,
  bySeverity: { critical: 3, high: 3, medium: 2 },
  recordedThisTurn: false,
  selfInconsistent: false,
};

describe("severityInflationNote — facet B (live 17:12)", () => {
  it("catches the live claim: 8 krusial against 3 critical in the store", () => {
    const note = severityInflationNote(LIVE_PROSE, LIVE_FACTS);
    expect(note).toContain("dari 8 temuan yang tercatat");
    expect(note).toContain("hanya 3");
    expect(note).toContain("kritis");
    // The breakdown is the fact the user needs, not just the accusation.
    expect(note).toContain("3 critical");
    expect(note).toContain("3 high");
    expect(note).toContain("2 medium");
  });

  it("is silent when the prose carries no severity word", () => {
    expect(severityInflationNote("Laporannya sudah lengkap dengan 8 temuan.", LIVE_FACTS)).toBe("");
  });

  it("is silent on UNDERSTATEMENT (2 krusial when the store holds 3)", () => {
    // Inflating severity is the defect; a self-deprecating count is not.
    expect(severityInflationNote("Ada 2 temuan kritis di sana.", LIVE_FACTS)).toBe("");
  });

  it("is silent when the claim matches the store exactly", () => {
    expect(severityInflationNote("Ada 3 temuan kritis.", LIVE_FACTS)).toBe("");
  });

  it("is silent on a fuzzy count", () => {
    expect(severityInflationNote("sekitar 8 temuan krusial.", LIVE_FACTS)).toBe("");
    expect(severityInflationNote("kira-kira 8 temuan kritis.", LIVE_FACTS)).toBe("");
    expect(severityInflationNote("± 8 temuan kritis.", LIVE_FACTS)).toBe("");
  });

  it("is silent when the store is empty — no facts, no accusation", () => {
    expect(severityInflationNote(LIVE_PROSE, emptyFindingClaimFacts())).toBe("");
  });

  it("is silent when the turn recorded a finding (the set is still growing)", () => {
    expect(severityInflationNote(LIVE_PROSE, { ...LIVE_FACTS, recordedThisTurn: true, selfInconsistent: false })).toBe("");
  });

  it("never reads a CVSS score as a count", () => {
    // "9.8" is a digit glued to a dot and "8x" a digit glued to an x; treating
    // either as a count would manufacture a contradiction out of two facts
    // that merely share a sentence.
    expect(severityInflationNote("Severity tinggi dengan CVSS 9.8.", LIVE_FACTS)).toBe("");
    expect(severityInflationNote("Tingkat tinggi, 8x lebih lambat.", LIVE_FACTS)).toBe("");
  });

  it("is silent when the clause names a different target", () => {
    // The snapshot is host-scoped; another host's count cannot refute it.
    expect(
      severityInflationNote(
        "Di lab lain ada 8 temuan krusial di https://other.example/app.",
        LIVE_FACTS,
      ),
    ).toBe("");
  });

  it("every word in the vocabulary table can actually fire (it cannot drift)", () => {
    // A term added to SEVERITY_CLAIM_WORDS but missing from the built regex
    // would sit there silently forever. This fails the moment that happens.
    for (const [word, bucket] of Object.entries(SEVERITY_CLAIM_WORDS)) {
      const facts: FindingClaimFacts = {
        total: 1,
        bySeverity: { [bucket]: 0 },
        recordedThisTurn: false,
        selfInconsistent: false,
      };
      expect(
        severityInflationNote(`Ada 8 temuan ${word}.`, facts),
        `word "${word}" never fires`,
      ).toContain("dilebihkan");
    }
  });
});

describe("discoveryAuthorshipNote — facet C (live 17:12)", () => {
  it("catches the live claim: 'yang aku temukan' with nothing recorded", () => {
    const note = discoveryAuthorshipNote(LIVE_PROSE, LIVE_FACTS);
    expect(note).toContain("SUDAH tercatat di giliran sebelumnya");
    expect(note).toContain("bukan hasil penemuan giliran ini");
  });

  it("catches the reverse word order", () => {
    expect(discoveryAuthorshipNote("8 temuan yang saya temukan.", LIVE_FACTS)).not.toBe("");
  });

  it("is silent when the clause admits it was already recorded", () => {
    // The honest form of the same sentence — the model may legitimately
    // re-verify, and saying so is exactly right.
    expect(
      discoveryAuthorshipNote("8 temuan yang sebelumnya sudah tercatat.", LIVE_FACTS),
    ).toBe("");
    expect(discoveryAuthorshipNote("Temuan yang sudah tercatat di giliran lalu.", LIVE_FACTS)).toBe(
      "",
    );
  });

  it("is silent when the turn recorded a finding", () => {
    expect(discoveryAuthorshipNote(LIVE_PROSE, { ...LIVE_FACTS, recordedThisTurn: true, selfInconsistent: false })).toBe("");
  });

  it("is silent without attribution", () => {
    expect(discoveryAuthorshipNote("8 temuan tercatat di laporan.", LIVE_FACTS)).toBe("");
  });

  it("is silent when the store is empty", () => {
    expect(discoveryAuthorshipNote(LIVE_PROSE, emptyFindingClaimFacts())).toBe("");
  });
});

describe("recordAuthorshipNote — facet D (live 2026-10-07 17:17)", () => {
  /**
   * The real reply. Facet D exists because all THREE pre-existing facets are
   * silent on this exact text — verified by probe, not assumed: the sentence
   * has no pronoun and uses a RECORD verb (not a discovery verb), there was no
   * `finding_add` attempt at all (so facet "unrecorded claim" had nothing to
   * latch onto), and it names no severity word (so facet B could not compare).
   * The second sentence is CORRECT and must never be accused — it is the
   * discriminator that keeps `STORE_SUBJECT_RE` honest.
   */
  const LIVE_1017 =
    "Mas Naufal, full pentest untuk cozy-kangaroo-42f2e0.netlify.app sudah mencatat 8 temuan di sistem, " +
    "termasuk celah injeksi dan kerentanan akses. Sistem secara otomatis sudah mencetak laporan PDF-nya " +
    "dari temuan-temuan aktif tersebut.";

  it("catches the live claim: 'sudah mencatat 8 temuan' with nothing recorded", () => {
    const note = recordAuthorshipNote(LIVE_1017, LIVE_FACTS);
    expect(note).toContain("SUDAH tercatat di giliran sebelumnya");
    expect(note).toContain("tidak menjalankan finding_add sama sekali");
    expect(note).toContain("bukan hasil pencatatan giliran ini");
  });

  it("leaves the honest second sentence of the SAME reply alone", () => {
    expect(
      recordAuthorshipNote(
        "Sistem secara otomatis sudah mencetak laporan PDF-nya dari temuan-temuan aktif tersebut.",
        LIVE_FACTS,
      ),
    ).toBe("");
  });

  it("catches every active record verb", () => {
    for (const verb of ["mencatat", "menyimpan", "merekam", "memasukkan", "menambahkan"]) {
      expect(recordAuthorshipNote(`Pentest tadi sudah ${verb} 8 temuan.`, LIVE_FACTS)).not.toBe("");
    }
  });

  // The `men-` morphology is the discriminator: `\bmencatat\b` cannot match
  // inside `tercatat` (no word boundary before `catat`), so the whole passive
  // family is silent without a second pattern to keep in sync.
  it("never accuses the passive/stative forms", () => {
    for (const t of [
      "8 temuan yang sudah tercatat di sistem.",
      "Temuan yang tercatat sejak September masih terbuka semua.",
      "Laporan memuat 8 temuan yang tersimpan di store.",
    ]) {
      expect(recordAuthorshipNote(t, LIVE_FACTS)).toBe("");
    }
  });

  it("treats a store/database subject as honest bookkeeping", () => {
    expect(recordAuthorshipNote("Store sudah mencatat 8 temuan untuk target ini.", LIVE_FACTS)).toBe("");
    expect(
      recordAuthorshipNote("Sistem sudah mencatat 8 temuan aktif.", LIVE_FACTS),
    ).toBe("");
  });

  it("is silent when the clause names an earlier turn", () => {
    expect(
      recordAuthorshipNote("Sudah tercatat 8 temuan pada giliran sebelumnya.", LIVE_FACTS),
    ).toBe("");
    expect(recordAuthorshipNote("Sudah mencatat 8 temuan yang lalu.", LIVE_FACTS)).toBe("");
  });

  it("is silent on a plan (not yet completed) and on honest failure", () => {
    expect(
      recordAuthorshipNote("Aku akan mencatat temuannya nanti setelah uji ulang selesai.", LIVE_FACTS),
    ).toBe("");
    expect(recordAuthorshipNote("Gagal mencatat temuannya karena judulnya kosong.", LIVE_FACTS)).toBe("");
  });

  it("is silent when the turn recorded a finding", () => {
    expect(recordAuthorshipNote(LIVE_1017, { ...LIVE_FACTS, recordedThisTurn: true })).toBe("");
  });

  it("is silent when the finding noun is absent, or the store is empty", () => {
    expect(recordAuthorshipNote("Sudah aku catat daftar bacaan kamu ya.", LIVE_FACTS)).toBe("");
    expect(recordAuthorshipNote(LIVE_1017, emptyFindingClaimFacts())).toBe("");
    expect(recordAuthorshipNote("", LIVE_FACTS)).toBe("");
  });
});

describe("recordedFindingThisTurn — the single owner of that fact", () => {
  const assistant = (id: string, name: string) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id, function: { name } }],
  });
  const tool = (id: string, content: string) => ({ role: "tool", content, tool_call_id: id });

  it("true when a finding_add succeeded", () => {
    expect(
      recordedFindingThisTurn([assistant("a1", "finding_add"), tool("a1", "✅ Temuan dicatat: F-1")]),
    ).toBe(true);
  });

  it("false when every finding_add errored (the live 22:52 shape)", () => {
    expect(
      recordedFindingThisTurn([assistant("a1", "finding_add"), tool("a1", "Error: judul temuan wajib")]),
    ).toBe(false);
  });

  it("false when the turn never called finding_add (the live 17:12 shape)", () => {
    // Absence of the call is evidence, not ignorance: a turn that records a
    // finding always has the call in its window.
    expect(recordedFindingThisTurn([assistant("a1", "http_request"), tool("a1", "200 OK")])).toBe(
      false,
    );
  });

  it("true when the results were summarized away (fail open)", () => {
    expect(recordedFindingThisTurn([assistant("a1", "finding_add")])).toBe(true);
  });
});

describe("findingClaimFacts + describeBreakdown", () => {
  it("builds counts from the rows the caller read", () => {
    const facts = findingClaimFacts(
      [
        { severity: "critical", target: "https://lab/a", status: "open" },
        { severity: "high", target: "https://lab/a", status: "open" },
        { severity: "critical", target: "https://lab/b", status: "open" },
      ],
      { recordedThisTurn: true },
    );
    expect(facts.total).toBe(3);
    expect(facts.bySeverity).toEqual({ critical: 2, high: 1 });
    expect(facts.recordedThisTurn).toBe(true);
  });

  it("orders the breakdown by severity and reads 'tidak ada' when empty", () => {
    expect(
      describeBreakdown({ total: 8, bySeverity: { medium: 2, critical: 3, high: 3 }, recordedThisTurn: false, selfInconsistent: false }),
    ).toBe("3 critical, 3 high, 2 medium");
    expect(describeBreakdown(emptyFindingClaimFacts())).toBe("tidak ada");
  });
});

describe("a store that disagrees with itself cannot refute prose (measured 2026-09-28)", () => {
  // The real shape: the owner host carries "Stored XSS in /api/pengaduan" with
  // cvss 7.1 and severity medium, while `severityFromCvss(7.1)` is high. Re-adding
  // that exact row through `addFinding` produced high, so a fresh copy counts
  // 3C/4H/1M where the stored rows count 3C/3H/2M. The report header counts the
  // STORED severities, so prose that is faithful to the report is exactly what a
  // severity check would otherwise accuse.
  const rows = [
    { severity: "critical", target: "https://lab/a", status: "open", cvss: 9.8 },
    { severity: "critical", target: "https://lab/a", status: "open", cvss: 9.1 },
    { severity: "critical", target: "https://lab/a", status: "open", cvss: 9.8 },
    { severity: "high", target: "https://lab/a", status: "open", cvss: 8.2 },
    { severity: "high", target: "https://lab/a", status: "open", cvss: 7.5 },
    { severity: "high", target: "https://lab/a", status: "open", cvss: 8.1 },
    { severity: "medium", target: "https://lab/a", status: "open", cvss: 7.1 }, // the liar
    { severity: "medium", target: "https://lab/a", status: "open", cvss: 4.3 },
  ];
  const LIVE = "Laporannya sudah lengkap dengan 8 temuan krusial yang aku temukan.";
  const HONEST = "Laporannya memuat 3 temuan kritis, 3 tinggi, dan 2 sedang, semuanya sudah tercatat sebelumnya.";

  it("flags the self-inconsistency from the row's own CVSS band", () => {
    expect(findingClaimFacts(rows, { recordedThisTurn: false }).selfInconsistent).toBe(true);
  });

  it("a consistent store is not flagged", () => {
    const clean = rows.map((r) => (r.cvss === 7.1 ? { ...r, severity: "high" } : r));
    expect(findingClaimFacts(clean, { recordedThisTurn: false }).selfInconsistent).toBe(false);
  });

  it("SILENT on the inflated claim when the store contradicts itself", () => {
    expect(severityInflationNote(LIVE, findingClaimFacts(rows, { recordedThisTurn: false }))).toBe("");
  });

  it("SILENT on a summary that faithfully quotes the stored report header", () => {
    expect(severityInflationNote(HONEST, findingClaimFacts(rows, { recordedThisTurn: false }))).toBe("");
  });

  it("still FIRES once the same store is internally consistent", () => {
    const clean = rows.map((r) => (r.cvss === 7.1 ? { ...r, severity: "high" } : r));
    expect(severityInflationNote(LIVE, findingClaimFacts(clean, { recordedThisTurn: false }))).not.toBe("");
  });

  it("a row with no score cannot make the store inconsistent", () => {
    const noScore = [{ severity: "medium", target: "https://lab/a", status: "open" }];
    expect(findingClaimFacts(noScore, { recordedThisTurn: false }).selfInconsistent).toBe(false);
  });

  it("the authorship facet is unaffected — it never depends on the band", () => {
    expect(
      discoveryAuthorshipNote(LIVE, findingClaimFacts(rows, { recordedThisTurn: false })),
    ).not.toBe("");
  });
});

describe("passive and scattered 'temuan' prose is NOT an authorship claim (live drill 18:0x)", () => {
  // The drill fired the facet on a 2045-char reply with no authorship claim in it,
  // because the old vocabulary counted `nemu|ketemu|found` and let the pronoun,
  // the verb and the noun sit anywhere in a clause. These are the shapes that
  // must stay silent: passive "ditemukan", a bare "temuan" list, and a long reply
  // where "aku" and "temuan" merely co-occur.
  const F = findingClaimFacts(
    [
      { severity: "critical", target: "https://lab/a", status: "open", cvss: 9.8 },
      { severity: "high", target: "https://lab/a", status: "open", cvss: 7.5 },
    ],
    { recordedThisTurn: false },
  );

  it("passive 'sudah ditemukan' is a statement about findings, not authorship", () => {
    expect(
      discoveryAuthorshipNote(
        "Saya sudah merangkum temuan audit lainnya dalam laporan, dan celah SQL injection itu sudah ditemukan pada pengujian sebelumnya.",
        F,
      ),
    ).toBe("");
  });

  it("a long reply where 'aku' and 'temuan' merely co-occur stays silent", () => {
    const long =
      "Aku sudah merangkum temuan audit lainnya dalam laporan PDF yang mencakup tiga temuan kritis. " +
      "Aku juga sudah memastikan setiap temuan punya bukti. " +
      "Temuan SQL injection di /api/cari-berita bisa dikonfirmasi ulang. " +
      "Temuan IDOR di /api/cek-nik juga terverifikasi. " +
      "Semua temuan itu sudah tercatat sebelumnya di lab ini.";
    expect(discoveryAuthorshipNote(long, F)).toBe("");
  });

  it("'aku menemukan N temuan' still fires — the active form is the claim", () => {
    expect(discoveryAuthorshipNote("Aku menemukan 8 temuan di lab itu.", F)).not.toBe("");
  });

  it("'temuan yang aku temukan' still fires — noun-first order", () => {
    expect(discoveryAuthorshipNote("Ada 8 temuan krusial yang aku temukan di sana.", F)).not.toBe("");
  });
});
