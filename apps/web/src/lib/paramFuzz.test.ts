// paramFuzz context-aware reflection tests (precision #3, 2026-09-28).
//
// Old behavior: ANY reflected XSS payload → "reflection (cek XSS konteks)" —
// one signal for two very different facts. New contract: the signal NAMES the
// context — execution-position reflection is lead-grade ("XSS exec-context"),
// page-text/encoded reflection is info ("reflection only — …"), matching the
// xssProofAdvisory vocabulary (a payload reflection is not the finding).
import { describe, expect, it } from "vitest";
import { classify, classifyReflectionContext, PAYLOADS } from "./paramFuzz";

const base = { status: 200, body: "<p>halaman biasa</p>", loc: "", ms: 10, err: false };
const res = (body: string) => ({ status: 200, body, loc: "", ms: 10, err: false });

describe("classifyReflectionContext — exec positions (lead-grade)", () => {
  it("breakout payload reflected raw becomes live markup", () => {
    const payload = PAYLOADS.xss[0]; // '"><img src=x onerror=alert(1)>'
    const ctx = classifyReflectionContext(`<div>hasil: ${payload}</div>`, payload);
    expect(ctx.kind).toBe("exec");
  });
  it("raw <script> block is exec", () => {
    const payload = PAYLOADS.xss[2]; // <script>alert(1)</script>
    expect(classifyReflectionContext(`ok ${payload} done`, payload).kind).toBe("exec");
  });
  it("javascript: URL inside a link attribute is exec", () => {
    const payload = "javascript:alert(1)";
    expect(classifyReflectionContext(`<a href="${payload}">klik</a>`, payload).kind).toBe("exec");
  });
  it("handler injected inside an unterminated tag is exec", () => {
    const payload = "onerror=alert(1)";
    expect(classifyReflectionContext(`<img src=x ${payload}>`, payload).kind).toBe("exec");
  });
});

describe("classifyReflectionContext — inert positions (info)", () => {
  it("page-text reflection without an execution position is info", () => {
    const ctx = classifyReflectionContext("dokumen menyebut javascript:alert(1) sebagai contoh", "javascript:alert(1)");
    expect(ctx.kind).toBe("info");
  });
  it("bare handler in text (not inside a tag) is info", () => {
    expect(classifyReflectionContext("catatan onerror=alert(1) dalam teks.", "onerror=alert(1)").kind).toBe("info");
  });
  it("only the URL-encoded form came back → server escape, inert", () => {
    const payload = "javascript:alert(1)";
    const ctx = classifyReflectionContext(`data:javascript%3Aalert(1)`, payload);
    expect(ctx.kind).toBe("info");
    expect(ctx.detail).toContain("ter-encode");
  });
});

describe("classify() — signal names the context", () => {
  it("exec-position reflection is lead-grade, not the old blanket signal", () => {
    const payload = PAYLOADS.xss[1]; // '"><svg/onload=alert(1)>'
    const signals = classify(payload, "xss", res(`<p>ok ${payload}</p>`), base);
    expect(signals.some((s) => s.startsWith("XSS exec-context"))).toBe(true);
    expect(signals.every((s) => !s.includes("cek XSS konteks"))).toBe(true);
  });
  it("encoded-only reflection is info, never exec-grade", () => {
    const payload = "javascript:alert(1)";
    const signals = classify(payload, "xss", res(`log:javascript%3Aalert(1)`), base);
    expect(signals.some((s) => s.startsWith("reflection only"))).toBe(true);
    expect(signals.every((s) => !s.startsWith("XSS exec-context"))).toBe(true);
  });
  it("design intent: raw-reflected breakout XSS payloads classify exec; bare javascript: stays info", () => {
    for (const payload of PAYLOADS.xss) {
      const ctx = classifyReflectionContext(`page ${payload} tail`, payload);
      if (payload.startsWith("javascript:")) expect(ctx.kind).toBe("info");
      else expect(ctx.kind).toBe("exec");
    }
  });
});
