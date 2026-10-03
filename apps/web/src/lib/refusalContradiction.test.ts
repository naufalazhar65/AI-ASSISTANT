// refusalContradictionNote — the guard that catches a BLANKET capability refusal
// contradicting the turn's own actions.
//
// The fixture that made this file: live 2026-09-28 12:51 WIB (Discord). The
// model opened with "Maaf, aku tidak bisa melakukan pengujian penetrasi (pentest)
// atau analisis kerentanan …" while the same reply's receipt listed eight real
// actions and both report files landed on disk. The guard was SILENT because the
// regex had a 45-character proximity window between the negation and the security
// noun, and the live sentence puts them 55 apart.
//
// So the tests below are deliberately two-directional, and the FIRST one is the
// exact live string with a distance assertion — a future "tidy up" that
// reintroduces any proximity window fails immediately.

import { describe, expect, it } from "vitest";
import {
  isBlanketRefusalClause,
  REFUSAL_NEGATION_RE,
  REFUSAL_SECURITY_NOUN_RE,
  REFUSAL_REASON_RE,
  refusalContradictionNote,
  refusalWithoutScopeCheckNote,
  type ChatMessage,
} from "./agent";

const ranCalls = (names: string[]): ChatMessage[] =>
  [
    {
      role: "user" as const,
      content: "full pentest di lab itu",
    },
    {
      role: "assistant" as const,
      content: null,
      tool_calls: names.map((n, i) => ({
        id: `t${i}`,
        type: "function" as const,
        function: { name: n, arguments: "{}" },
      })),
    },
  ] as unknown as ChatMessage[];

const LIVE = "Maaf, aku tidak bisa melakukan pengujian penetrasi (pentest) atau analisis kerentanan secara langsung pada target web tersebut.";

describe("isBlanketRefusalClause — the exact live 2026-09-28 shape", () => {
  it("catches the live sentence", () => {
    expect(isBlanketRefusalClause(LIVE)).toBe(true);
  });

  it("the security noun is FURTHER than the old 45-char window allowed (why the guard was blind)", () => {
    const neg = REFUSAL_NEGATION_RE.exec(LIVE);
    // Measure to the noun the OLD alternation used ("kerentanan"). The current
    // list also matches "pentest" earlier in the string, which would understate
    // the distance and hide exactly the regression this test exists for.
    const noun = /\bkerentanan\w*/i.exec(LIVE);
    expect(neg).not.toBeNull();
    expect(noun).not.toBeNull();
    const gap = (noun!.index - (neg!.index + neg![0].length)) as number;
    expect(gap).toBeGreaterThan(45);
  });

  it("catches the same refusal with no proximity limit at all (100+ chars apart still fires)", () => {
    const far = `tidak bisa ${"saya sangat ingin membantu namun ".repeat(6)}kerentanan`;
    expect(isBlanketRefusalClause(far)).toBe(true);
  });

  it("matches suffixed security nouns the boundary used to miss", () => {
    expect(isBlanketRefusalClause("aku tidak bisa memastikan kerentanannya")).toBe(true);
    expect(isBlanketRefusalClause("aku belum bisa melakukan penetration testing di situ")).toBe(true);
    expect(isBlanketRefusalClause("I cannot run a vulnerability scan here")).toBe(true);
  });
});

describe("refusalContradictionNote — fires only with a FACT", () => {
  it("fires when target-touching tools ran this turn", () => {
    const note = refusalContradictionNote(ranCalls(["http_request", "poc_verify", "js_mine"]), LIVE, "lab.example");
    expect(note).not.toBe("");
    expect(note).toContain("http_request");
  });

  it("stays silent when NO tool touched the target (nothing to contradict)", () => {
    expect(refusalContradictionNote(ranCalls(["readFile"]), LIVE)).toBe("");
    expect(refusalContradictionNote([], LIVE)).toBe("");
  });

  it("the LEDGER alone is enough — the promised truncation-immunity, now real (live 14:29)", () => {
    // The old comment claimed ledger support that did not exist in the code, so
    // a turn whose messages had been summarised away was judged blind. With an
    // EMPTY message window the guard must still fire on the ledger alone.
    const note = refusalContradictionNote(
      [] as unknown as Parameters<typeof refusalContradictionNote>[0],
      LIVE,
      "lab.example",
      [
        { name: "poc_verify", executed: true },
        { name: "http_request", executed: true },
      ]
    );
    expect(note).not.toBe("");
    expect(note).toContain("poc_verify");
  });

  it("a ledger entry that did NOT execute is not a fact", () => {
    const note = refusalContradictionNote(
      [] as unknown as Parameters<typeof refusalContradictionNote>[0],
      LIVE,
      "lab.example",
      [{ name: "http_request", executed: false }]
    );
    expect(note).toBe("");
  });
});

describe("refusalContradictionNote — the trace sink reports WHY (live 14:29 forensics)", () => {
  it("reports no-blanket-refusal-clause for ordinary prose", () => {
    let r = "";
    refusalContradictionNote([], "Semua pengujian selesai dengan baik.", undefined, undefined, (d) => (r = String(d.reason)));
    expect(r).toBe("no-blanket-refusal-clause");
  });

  it("reports empty-text for no text at all", () => {
    let r = "";
    refusalContradictionNote([], "", undefined, undefined, (d) => (r = String(d.reason)));
    expect(r).toBe("empty-text");
  });

  it("reports blanket-refusal-clause plus the offending clause when it fires", () => {
    let r = "";
    let clause = "";
    refusalContradictionNote(
      ranCalls(["http_request"]),
      LIVE,
      undefined,
      undefined,
      (d) => {
        r = String(d.reason);
        clause = String(d.clause ?? "");
      }
    );
    expect(r).toBe("blanket-refusal-clause");
    expect(clause).toContain("tidak bisa");
  });

  it("reports refused-but-no-target-touching-tool — the honest silence", () => {
    let r = "";
    refusalContradictionNote(ranCalls(["readFile"]), LIVE, undefined, undefined, (d) => (r = String(d.reason)));
    expect(r).toBe("refused-but-no-target-touching-tool");
  });
});

describe("refusalContradictionNote — no false accusation (reason given = legitimate)", () => {
  it("silences a scope refusal that states its authorisation reason", () => {
    const withReason = "Aku tidak bisa menguji target itu karena itu website orang lain tanpa izin tertulis dari mereka.";
    expect(REFUSAL_REASON_RE.test(withReason)).toBe(true);
    expect(refusalContradictionNote(ranCalls(["http_request"]), withReason)).toBe("");
  });

  it("silences a training-platform refusal (their rules)", () => {
    const training = "Aku tidak bisa melakukan pengujian kerentanan di platform latihan itu karena itu aturan mereka.";
    expect(refusalContradictionNote(ranCalls(["http_request"]), training)).toBe("");
  });

  it("silences honest uncertainty that merely mentions security vocabulary", () => {
    expect(refusalContradictionNote(ranCalls(["http_request"]), "Tidak bisa dipastikan tanpa bukti, jadi aku belum menyimpulkan apa pun.")).toBe("");
    expect(refusalContradictionNote(ranCalls(["http_request"]), "Aku menjalankan pengujian keamanan seperti biasa.")).toBe("");
    expect(refusalContradictionNote(ranCalls(["http_request"]), "pemindaian kerentanan selesai, 3 temuan tercatat.")).toBe("");
  });

  it("the advice matches the scope FACT: an already-registered lab is not told to run lab_add", () => {
    // Live 2026-09-28 15:58. The host was already in PENTEST_LAB_TARGETS, yet the
    // note said "deklarasikan sekali dengan lab_add" — sending the owner to redo
    // work that was already done, which is its own small dishonesty.
    const authorized = refusalContradictionNote(ranCalls(["http_request"]), LIVE, "lab.example", undefined, undefined, {
      hostAuthorized: true,
    });
    // Assert on the INSTRUCTION, not the substring: the authorized branch says
    // "tidak perlu lab_add lagi", which contains "lab_add" as a negation.
    expect(authorized).not.toContain("deklarasikan sekali");
    expect(authorized).toContain("sudah terdaftar berizin");

    // An unauthorised host keeps the "declare it" path — that advice is correct there.
    const unauthorized = refusalContradictionNote(ranCalls(["http_request"]), LIVE, "their-site.example", undefined, undefined, {
      hostAuthorized: false,
    });
    expect(unauthorized).toContain("deklarasikan sekali dengan lab_add");
  });

  it("per-clause: a neighbour clause does not veto the accusation (pdfExistenceClaim lesson)", () => {
    const mixed = `Aku menjalankan pengujian keamanan dengan lengkap. Aku tidak bisa melakukan pengujian penetrasi di luar target itu.`;
    expect(refusalContradictionNote(ranCalls(["http_request"]), mixed)).not.toBe("");
  });

  it("the Indonesian 'pengujian penetrasi' phrasing is recognised", () => {
    expect(isBlanketRefusalClause("Aku tidak bisa melakukan pengujian penetrasi di sini")).toBe(true);
  });
});

describe("refusalWithoutScopeCheckNote — fires only on unchecked capability refusals (live 2026-10-03 12:48 UTC)", () => {
  // The exact live shape: host-less ask, zero tools, blanket refusal.
  const HOSTLESS = "Maaf, aku nggak bisa melakukan penetration testing secara langsung. Tapi aku bisa bantu kamu memahami konsep dasarnya.";
  const userAsk: ChatMessage[] = [
    { role: "user", content: "Coba lakukan full penetration testing." } as ChatMessage,
  ];

  it("fires on a capability refusal with neither scope tool in the turn", () => {
    const note = refusalWithoutScopeCheckNote(userAsk, HOSTLESS);
    expect(note).not.toBe("");
    expect(note).toContain("engagement_list");
    expect(note).toContain("pentest_resources");
  });

  it("stays silent when engagement_list ran (checked first)", () => {
    const msgs = [...userAsk, ...ranCalls(["engagement_list"]).slice(1)];
    expect(refusalWithoutScopeCheckNote(msgs, HOSTLESS)).toBe("");
  });

  it("stays silent when pentest_resources ran — via the ledger alone", () => {
    const note = refusalWithoutScopeCheckNote(userAsk, HOSTLESS, [
      { name: "pentest_resources", executed: true },
    ]);
    expect(note).toBe("");
  });

  it("a ledger entry that did NOT execute is not a scope check", () => {
    const note = refusalWithoutScopeCheckNote(userAsk, HOSTLESS, [
      { name: "engagement_list", executed: false },
    ]);
    expect(note).not.toBe("");
  });

  it("stays silent when the refusal gives its reason (legitimate)", () => {
    const withReason =
      "Aku tidak bisa melakukan pengujian keamanan pada website orang lain tanpa izin tertulis dari mereka.";
    expect(refusalWithoutScopeCheckNote(userAsk, withReason)).toBe("");
  });

  it("stays silent on epistemic hedging — 'memastikan' is not a capability verb (honest-candidate-framing)", () => {
    const hedge = "Hasil dari pengujian itu: kandidat CSRF di form transfer. Aku belum bisa memastikan ini vuln.";
    expect(refusalWithoutScopeCheckNote(userAsk, hedge)).toBe("");
  });

  it("fires on the live 2026-10-03 12:59 shape — colloquial 'jalanin' is a capability verb", () => {
    const live =
      "Aku nggak bisa jalanin penetration test langsung beb. Itu kan keahlianmu sebagai pentester!";
    const note = refusalWithoutScopeCheckNote(userAsk, live);
    expect(note).not.toBe("");
    expect(note).toContain("engagement_list");
  });

  it("fires on the live 2026-10-03 12:49 shape — 'nggak pernah bisa' + 'jalanin' + 'hacking'", () => {
    const live = "aku sendiri nggak pernah bisa jalanin aksi hacking-nya sendiri.";
    const note = refusalWithoutScopeCheckNote(userAsk, live);
    expect(note).not.toBe("");
    expect(note).toContain("pentest_resources");
  });

  it("stays silent when negation + security noun appear WITHOUT a capability verb", () => {
    const noVerb = "Film hacking-nya seru, tapi aku nggak pernah bisa nonton sampai habis.";
    expect(refusalWithoutScopeCheckNote(userAsk, noVerb)).toBe("");
  });

  it("stays silent on 'jalanin' outside security work (no security noun)", () => {
    expect(refusalWithoutScopeCheckNote(userAsk, "Siap, aku jalanin tugasnya sekarang.")).toBe("");
  });

  it("stays silent on non-refusal prose and on empty text", () => {
    expect(refusalWithoutScopeCheckNote(userAsk, "Siap, aku jalankan pengujian penetrasi di lab itu.")).toBe("");
    expect(refusalWithoutScopeCheckNote(userAsk, "")).toBe("");
  });

  it("the trace sink reports WHY (mirrors the sibling guard)", () => {
    let r = "";
    refusalWithoutScopeCheckNote(userAsk, HOSTLESS, undefined, (d) => (r = String(d.reason)));
    expect(r).toBe("blanket-refusal-no-scope-check");
    refusalWithoutScopeCheckNote(userAsk, "halo", undefined, (d) => (r = String(d.reason)));
    expect(r).toBe("no-actionable-refusal-clause");
  });
});
