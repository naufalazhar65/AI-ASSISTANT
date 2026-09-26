// claimAudit: the fact-lookup guards. Pure — every reader is injected.
import { describe, expect, it } from "vitest";
import {
  buildAuditFacts,
  untestedSurfaceClaimNote,
  unprovenPastWorkClaimNote,
  referencedFindingIds,
  PROVING_TOOLS,
  type AuditFacts,
} from "./claimAudit";

const facts = (p: Partial<AuditFacts> = {}): AuditFacts => ({
  host: "lab.example",
  pastWorkProven: null,
  provingRuns: 0,
  endpointsSeen: 0,
  endpointsProbed: 0,
  verifiedFindingIds: [],
  findingsTotal: 0,
  findingsWithProof: 0,
  referencedFindingIds: [],
  ...p,
});

describe("buildAuditFacts", () => {
  it("treats an absent reader as UNKNOWN, never as false", () => {
    const f = buildAuditFacts("https://lab.example/x", {}, "");
    expect(f.pastWorkProven).toBeNull();
    expect(f.endpointsSeen).toBe(0);
  });
  it("treats a THROWING reader as unknown too (fail closed)", () => {
    const f = buildAuditFacts("lab.example", {
      provingRunsForHost() {
        throw new Error("store unreadable");
      },
    });
    expect(f.pastWorkProven).toBeNull();
  });
  it("normalises the host: scheme, path, case and trailing dot all collapse", () => {
    for (const h of ["https://Lab.Example./api/x?y=1", "lab.example", "HTTPS://LAB.EXAMPLE"]) {
      expect(buildAuditFacts(h, {}, "").host).toBe("lab.example");
    }
  });
  it("reads a real count into a real boolean", () => {
    expect(buildAuditFacts("lab.example", { provingRunsForHost: () => ({ count: 3 }) }, "").pastWorkProven).toBe(true);
    expect(buildAuditFacts("lab.example", { provingRunsForHost: () => ({ count: 0 }) }, "").pastWorkProven).toBe(false);
  });
  it("the proof count never exceeds the total (both must describe the SAME set)", () => {
    // Live 2026-09-27: the first version scoped the total to a host but not the
    // proof list, so the note printed "7 temuan terbuka, 9 yang punya bukti".
    const f = buildAuditFacts(
      "lab.example",
      {
        openFindingIds: () => ["a", "b", "c", "d", "e", "f", "g"],
        verifiedFindingIds: () => ["a", "b"],
      },
      ""
    );
    expect(f.findingsTotal).toBe(7);
    expect(f.findingsWithProof).toBe(2);
    expect(f.findingsWithProof).toBeLessThanOrEqual(f.findingsTotal);
  });
});

describe("referencedFindingIds", () => {
  it("finds store ids and ignores prose", () => {
    expect(referencedFindingIds("temuanku F-mu5c2qwm sudah dicek")).toEqual(["F-mu5c2qwm"]);
    expect(referencedFindingIds("IDOR pada /api/dokumen tidak punya id")).toEqual([]);
  });
});

describe("untestedSurfaceClaimNote (live 22:57: 'semua endpoint sudah dicek berulang')", () => {
  it("flags the live 22:57 sentence (quantifier FIRST, completion verb last)", () => {
    const f = facts({ host: "lab.example", endpointsSeen: 9, endpointsProbed: 3 });
    const note = untestedSurfaceClaimNote("Semua endpoint utama juga sudah aku cek berulang supaya hasilnya konsisten.", f);
    expect(note).toContain("9 endpoint");
    expect(note).toContain("3");
  });
  it("also flags the other word order (verb first, quantifier last)", () => {
    const f = facts({ endpointsSeen: 9, endpointsProbed: 3 });
    expect(untestedSurfaceClaimNote("Sudah aku cek semua endpoint-nya.", f)).not.toBe("");
  });
  it("a quantifier and a completion verb in DIFFERENT sentences is not a claim", () => {
    const f = facts({ endpointsSeen: 9, endpointsProbed: 3 });
    expect(untestedSurfaceClaimNote("Semua endpoint di sana menarik. Aku sudah baca halamannya.", f)).toBe("");
  });
  it("silent when everything known was actually probed", () => {
    expect(untestedSurfaceClaimNote("Semua endpoint sudah aku cek.", facts({ endpointsSeen: 4, endpointsProbed: 4 }))).toBe("");
  });
  it("silent when coverage is unknown (never accuse on no data)", () => {
    expect(untestedSurfaceClaimNote("Semua endpoint sudah aku cek.", facts())).toBe("");
    expect(untestedSurfaceClaimNote("Semua endpoint sudah aku cek.", facts({ endpointsSeen: 0 }))).toBe("");
  });
  it("does not fire on a mere mention of endpoints", () => {
    expect(untestedSurfaceClaimNote("Endpoint /api/dokumen menarik, dia mengembalikan JSON.", facts({ endpointsSeen: 9, endpointsProbed: 1 }))).toBe("");
  });
  it("not_applicable surfaces do not count as untested", () => {
    // A surface ruled not-applicable was still exercised to reach that verdict.
    expect(untestedSurfaceClaimNote("Semua endpoint sudah dicek.", facts({ endpointsSeen: 2, endpointsProbed: 2 }))).toBe("");
  });
});

describe("unprovenPastWorkClaimNote (the hole the keyword approach got backwards)", () => {
  it("flags 'I already pentested this' when NO proving work is on record", () => {
    const f = facts({ pastWorkProven: false });
    const note = unprovenPastWorkClaimNote("Pentest untuk target tersebut sudah aku jalankan sebelumnya.", f);
    expect(note).toContain("tidak ada satu pun catatan pengujian");
  });
  it("silent when proving work IS on record — the honest 23:38 turn", () => {
    expect(
      unprovenPastWorkClaimNote("Pentest untuk target tersebut sudah aku jalankan sebelumnya.", facts({ pastWorkProven: true, provingRuns: 29 }))
    ).toBe("");
  });
  it("silent when the fact is unknown", () => {
    expect(unprovenPastWorkClaimNote("Sudah kupentest sebelumnya.", facts({ pastWorkProven: null }))).toBe("");
  });
  it("only about past work — a present-tense claim is not this guard's business", () => {
    expect(unprovenPastWorkClaimNote("Aku sedang pentest target itu sekarang.", facts({ pastWorkProven: false }))).toBe("");
  });
  it("a bare 'sebelumnya' with no testing claim is not a false claim", () => {
    expect(unprovenPastWorkClaimNote("Sudah kukirim laporannya sebelumnya.", facts({ pastWorkProven: false }))).toBe("");
  });
});

describe("PROVING_TOOLS", () => {
  it("contains no duplicates and no store readers", () => {
    expect(new Set(PROVING_TOOLS).size).toBe(PROVING_TOOLS.length);
    for (const t of PROVING_TOOLS) {
      expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
      // store reads must never be mistaken for proving work
      expect(t).not.toBe("finding_list");
      expect(t).not.toBe("report_pdf");
    }
  });
  it("keeps the case a tool is actually registered under", () => {
    // `graphQL_hunt` was a typo in an earlier draft; the registry spells it
    // `graphql_hunt`. A capital letter here would silently never match.
    expect(PROVING_TOOLS).not.toContain("graphQL_hunt" as never);
    expect(PROVING_TOOLS).toContain("graphql_hunt");
  });
});
