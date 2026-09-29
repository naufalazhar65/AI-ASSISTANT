// verdictTaxonomy meta-test (precision #5, 2026-09-28).
//
// Three layers:
// 1. Table validity: every mapped verdict is a canonical class; classification
//    never throws for any key in the table.
// 2. REAL-prover iteration: run the actual verdict functions and assert the
//    tool-enum lookup lands in the canonical classes (catches wording drift).
// 3. Narration mapper: the ordered rules — anti-fp first (an honest "bukan
//    bypass" is never a lead), then negative, confirmed, lead, unknown.
import { describe, expect, it } from "vitest";
import {
  classifyToolVerdict,
  classifyVerdictText,
  taxonomyUnknownVerdicts,
  VERDICT_CLASSES,
  taxonomySelfCheck,
  hasLeadMarker,
  hasConfirmedMarker,
} from "./verdictTaxonomy";
import { timingVerdict } from "./baseline";
import { classifyBypass } from "./bypass403";
import { rateLimitVerdict, oracleSignatures } from "./otpProbe";
import { classifySmuggle } from "./smuggleProbe";
import { classifyDomXss } from "./domXssProve";
import { assessTeamCityVersion } from "./teamcityCheck";
import { classifyMutation } from "./workflowFuzz";
import { classifyExport } from "./csvInject";
import { tokenEntropyVerdict, enumVerdict } from "./accountRecovery";
import { composeVerdict } from "./vulnCompose";
import { classifyReflectionContext } from "./paramFuzz";

const inVocab = (c: string) => (VERDICT_CLASSES as readonly string[]).includes(c);

describe("table validity", () => {
  it("classifies every mapped verdict without throwing", () => {
    const probe = [
      ["bypass403", "✅ BYPASS LEAD", "lead"],
      ["bypass403", "200 tapi body SAMA", "negative"],
      ["otp", "NO-RATE-LIMIT", "lead"],
      ["otp", "THROTTLED", "negative"],
      ["smuggle", "CONFIRMED", "confirmed"],
      ["smuggle", "NO-DESYNC", "negative"],
      ["dom_xss", "PROVEN", "confirmed"],
      ["dom_xss", "INJECTED_ONLY", "lead"],
      ["teamcity", "VULNERABLE", "confirmed"],
      ["teamcity", "PATCHED", "negative"],
      ["workflow", "signal", "lead"],
      ["workflow", "match", "negative"],
      ["csv", "raw", "lead"],
      ["csv", "sanitized", "negative"],
      ["recovery_token", "identical", "lead"],
      ["recovery_token", "ok", "negative"],
      ["vuln_compose", "TERBUKTI PENUH", "confirmed"],
      ["vuln_compose", "PUTUS", "unknown"],
    ] as const;
    for (const [tool, v, cls] of probe) expect(classifyToolVerdict(tool, v)).toBe(cls);
  });
  it("throws for an unmapped verdict (forces the table to grow with provers)", () => {
    expect(() => classifyToolVerdict("bypass403", "mystical-outcome")).toThrow();
    expect(() => classifyToolVerdict("nonexistent-tool", "anything")).toThrow();
  });
  it("exposes unknown-class verdicts for audit", () => {
    const unknowns = taxonomyUnknownVerdicts();
    expect(unknowns).toContain("smuggle:UNKNOWN");
    expect(unknowns.length).toBeGreaterThan(5);
  });
});

describe("REAL prover verdicts land in the canonical classes", () => {
  const deny = { status: 403, body: "403 deny id 12345678", headers: {}, ms: 5 };
  const as200 = (body: string) => ({ status: 200, body, headers: {}, ms: 6 });

  it("bypass403.classifyBypass → lead / negative / anti-fp", () => {
    expect(classifyToolVerdict("bypass403", classifyBypass(deny, as200("ADMIN PANEL totally different"), { name: "x", kind: "header", url: "http://h/admin", method: "GET" })[0])).toBe("lead");
    expect(classifyToolVerdict("bypass403", classifyBypass(deny, as200("403 deny id 12345678"), { name: "x", kind: "path", url: "http://h/admin", method: "GET" })[0])).toBe("negative");
    expect(classifyToolVerdict("bypass403", classifyBypass(deny, as200("echo /%2e/admin only"), { name: "x", kind: "path", url: "http://h/%2e/admin", method: "GET" })[0])).toBe("anti-fp");
  });
  it("otpProbe rateLimitVerdict kinds + oracle diffs → classes", () => {
    expect(classifyToolVerdict("otp", rateLimitVerdict([429, 429], ["x", "y"]).kind === "seen" ? "THROTTLED" : "NO-RATE-LIMIT")).toBe("negative");
    expect(classifyToolVerdict("otp", rateLimitVerdict([401, 401], ["x", "y"]).kind === "absent" ? "NO-RATE-LIMIT" : "THROTTLED")).toBe("lead");
    const base = { status: 401, body: "invalid", headers: {}, ms: 5 };
    const diff = { status: 200, body: '{"ok":true}', headers: {}, ms: 6 };
    const sig = oracleSignatures(base, [diff, base]);
    expect(sig.successLike.length).toBe(1);
    expect(classifyToolVerdict("otp", "ORACLE DIFF")).toBe("lead");
  });
  it("smuggleProbe classifySmuggle → confirmed / negative", () => {
    // CONFIRMED = canary answered in ≤2 total responses (misattribution proof).
    const confirmed = "HTTP/1.1 200 OK\r\n\r\nACL /AHTTP/1.1 200 OK\r\n\r\nB";
    expect(classifyToolVerdict("smuggle", classifySmuggle(confirmed, "A").verdict)).toBe("confirmed");
    expect(classifyToolVerdict("smuggle", classifySmuggle("HTTP/1.1 200 OK\r\nContent-Length: 101\r\n\r\nplain 101", "A").verdict)).toBe("negative");
  });
  it("domXssProve classifyDomXss → confirmed / lead / negative", () => {
    expect(classifyToolVerdict("dom_xss", classifyDomXss([{ source: "hash", exec: true, injected: true, note: "" }]).verdict)).toBe("confirmed");
    expect(classifyToolVerdict("dom_xss", classifyDomXss([{ source: "hash", exec: false, injected: true, note: "" }]).verdict)).toBe("lead");
    expect(classifyToolVerdict("dom_xss", classifyDomXss([{ source: "hash", exec: false, injected: false, note: "" }]).verdict)).toBe("negative");
  });
  it("teamcityCheck assessTeamCityVersion → confirmed / negative", () => {
    expect(classifyToolVerdict("teamcity", assessTeamCityVersion({ year: 2026, minor: 1, patch: 2, raw: "2026.1.2" }).verdict)).toBe("confirmed");
    expect(classifyToolVerdict("teamcity", assessTeamCityVersion({ year: 2026, minor: 1, patch: 3, raw: "2026.1.3" }).verdict)).toBe("negative");
  });
  it("workflowFuzz classifyMutation → lead / negative", () => {
    // The repeat SIGNAL = identical last-step digest where the outcome SIGNATURE
    // still differs (real double-processing shape, from batch2.test). The skip
    // MATCH = identical full signature → honest negative.
    const step = (status: number, body: string, digest: string, ms = 10) => ({ status, body, digest, ms });
    const base = { ok: true, results: [step(200, "cart", "c1"), step(200, "receipt", "r9")], failAt: -1 };
    const same = { ok: true, results: [step(200, "cart", "c1"), step(200, "receipt", "r9")], failAt: -1 };
    const repeat = { ok: true, results: [step(200, "cart-1", "c2"), step(200, "receipt", "r9")], failAt: -1 };
    expect(classifyToolVerdict("workflow", classifyMutation(base, same, "skip").level)).toBe("negative");
    expect(classifyToolVerdict("workflow", classifyMutation(base, repeat, "repeat").level)).toBe("lead");
  });
  it("csvInject classifyExport → lead / negative / unknown", () => {
    expect(classifyToolVerdict("csv", classifyExport("=mia123456|payload", "=mia123456|payload", "text/csv").verdict)).toBe("lead");
    expect(classifyToolVerdict("csv", classifyExport("'=mia123456|payload", "=mia123456|payload", "text/csv").verdict)).toBe("negative");
    expect(classifyToolVerdict("csv", classifyExport("nothing here", "=mia123456|payload").verdict)).toBe("unknown");
  });
  it("accountRecovery tokenEntropyVerdict + enumVerdict → classes", () => {
    expect(classifyToolVerdict("recovery_token", tokenEntropyVerdict("aaaaaaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaaaaaa").verdict)).toBe("lead");
    expect(classifyToolVerdict("recovery_token", tokenEntropyVerdict("a1b2c3d4e5f6g7h8", "z9y8x7w6v5u4t3s2").verdict)).toBe("negative");
    const a = { status: 200, body: "user exists", ms: 5 };
    const b = { status: 200, body: "user exists", ms: 6 };
    expect(classifyToolVerdict("recovery_enum", enumVerdict(a, b).lead ? "lead" : "no enum")).toBe("lead");
  });
  it("vulnCompose composeVerdict → confirmed / unknown", () => {
    const hop = (proven: boolean) => ({ fromId: "F-1", toId: "F-2", kind: "endpoint" as const, shared: ["/api/x"], proven });
    expect(classifyToolVerdict("vuln_compose", composeVerdict([hop(true), hop(true)]).verdict)).toBe("confirmed");
    expect(classifyToolVerdict("vuln_compose", composeVerdict([hop(true), hop(false)]).verdict)).toBe("unknown");
  });
  it("paramFuzz reflection context (precision #3) → lead / info tiers", () => {
    const exec = classifyReflectionContext("x '><img src=x onerror=alert(1)>", "'><img src=x onerror=alert(1)>");
    expect(exec.kind).toBe("exec");
    const info = classifyReflectionContext("log:javascript%3Aalert(1)", "javascript:alert(1)");
    expect(info.kind).toBe("info");
  });
});

describe("narration mapper — order is the contract", () => {
  it("anti-fp wins over lead-looking words", () => {
    expect(classifyVerdictText("200 tapi body SAMA dengan halaman deny — bukan bypass")).toBe("anti-fp");
    expect(classifyVerdictText("hanya memantulkan path trik — kemungkinan echo")).toBe("anti-fp");
  });
  it("honest negatives stay negative even with the word lead", () => {
    expect(classifyVerdictText("Tidak ada auth-bypass lead: outcome sama dengan baseline")).toBe("negative");
    expect(classifyVerdictText("NO-DESYNC — request pipeline konsisten")).toBe("negative");
  });
  it("confirmed verdicts outrank lead wording", () => {
    expect(classifyVerdictText("LEAD (terkonfirmasi 3/3 PASS)")).toBe("confirmed");
    expect(classifyVerdictText("PROVEN — handler fired")).toBe("confirmed");
  });
  it("lead markers map to lead", () => {
    expect(classifyVerdictText("🎯 SSRF LEADS: param url → callback")).toBe("lead");
    expect(classifyVerdictText("BYPASS LEAD: 200, 18b — body berbeda")).toBe("lead");
  });
  it("inconclusive text stays unknown (never read as safe)", () => {
    expect(classifyVerdictText("gagal jaringan — tidak dinilai")).toBe("unknown");
    expect(classifyVerdictText("")).toBe("unknown");
  });
});

// ── Audit 2026-09-29: the four defects the old suite could not see ────────────
// Every one of them was invisible because NOTHING compared the table against
// the free-text mapper on the same input. `taxonomySelfCheck` is the mechanical
// guard that closes the whole class, not just these four cases.
describe("table vs mapper must agree (audit 2026-09-29)", () => {
  it("self-check reports NO disagreement across every table key", () => {
    const bad = taxonomySelfCheck();
    expect(bad).toEqual([]);
  });
  it("defect 1: bare INFO is unknown, never a lead (the table said unknown)", () => {
    expect(classifyToolVerdict("workflow", "info")).toBe("unknown");
    expect(classifyVerdictText("info")).toBe("unknown");
    expect(classifyVerdictText("info: 7 mutasi, 2 sinyal")).toBe("unknown");
  });
  it("defect 2: INJECTED_ONLY is a lead, matching the dom_xss table", () => {
    expect(classifyToolVerdict("dom_xss", "INJECTED_ONLY")).toBe("lead");
    expect(classifyVerdictText("INJECTED_ONLY (HTML masuk, tidak eksekusi)")).toBe("lead");
  });
  it("defect 3: THROTTLED is negative, matching the otp table", () => {
    expect(classifyToolVerdict("otp", "THROTTLED")).toBe("negative");
    expect(classifyVerdictText("THROTTLED: 429, rate limit saat probe")).toBe("negative");
  });
  it("defect 4: a later CONFIRMED is not downgraded by an earlier negation", () => {
    expect(classifyVerdictText("TIDAK ADA SINYAL tapi payload CONFIRMED masuk log")).toBe("confirmed");
    // …and the negation still wins when nothing confirms it.
    expect(classifyVerdictText("TIDAK ADA SINYAL di kedua lengan")).toBe("negative");
  });
});

describe("hasLeadMarker — precedence, not vocabulary (audit 2026-09-29)", () => {
  it("true on an explicit signal", () => {
    expect(hasLeadMarker("🎯 SSRF LEADS: param url")).toBe(true);
    expect(hasLeadMarker("LEADS: 3 endpoint")).toBe(true);
    expect(hasLeadMarker("STRONG — dibalik 200 vs 403")).toBe(true);
  });
  it("FALSE on the bare word inside an honest negation — that is the point", () => {
    expect(hasLeadMarker("Tidak ada auth-bypass lead di lengan lain")).toBe(false);
    expect(hasLeadMarker("ℹ️ info")).toBe(false);
  });
  it("classifyVerdictText still needs the bare word to protect the negation", () => {
    expect(classifyVerdictText("Tidak ada auth-bypass lead: outcome sama")).toBe("negative");
  });
  it("hasConfirmedMarker reads the same confirmed vocabulary", () => {
    expect(hasConfirmedMarker("PROVEN — handler fired")).toBe(true);
    expect(hasConfirmedMarker("🎯 LEADS: param url")).toBe(false);
  });
});

describe("timingVerdict narration must not name a payload it never saw", () => {
  it("states the measured delta and the threshold, never 'sleep 6'", () => {
    // baseA 400 / baseB 600 → avg 500, jitter 200; injected 7_000 → delta
    // 6_500 ≥ 5_000, injected > 3× avg, delta > 3× jitter ⇒ lead.
    const v = timingVerdict(400, 600, 7_000);
    expect(v.lead).toBe(true);
    expect(v.detail).not.toMatch(/sleep 6\b/);
    expect(v.detail).toContain("5s");
    expect(v.detail).toContain("6500ms");
  });
});
