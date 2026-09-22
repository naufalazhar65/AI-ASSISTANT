// Unit tests for http-history sanitization + finding proof warning (no disk).
import { describe, expect, it } from "vitest";
import { sanitizeHttpUrl } from "./httpHistory";
import { proofWarning } from "./tools";

describe("sanitizeHttpUrl (audit 2026-09-23)", () => {
  it("redacts credential-bearing values, keeps evidence params", () => {
    const u = sanitizeHttpUrl("http://127.0.0.1:4010/admin-login?u=admin&p=admin");
    expect(u).toContain("u=REDACTED");
    expect(u).toContain("p=REDACTED");
    expect(u).not.toContain("=admin");
  });
  it("redacts token/secret keys anywhere", () => {
    const u = sanitizeHttpUrl("https://lab.tld/api?token=abc123&id=7&q=cari");
    expect(u).toContain("token=REDACTED");
    expect(u).toContain("id=7");
    expect(u).toContain("q=cari");
  });
  it("leaves clean URLs byte-identical", () => {
    const clean = "https://lab.tld/api/dokumen?id=3&name=x";
    expect(sanitizeHttpUrl(clean)).toBe(clean);
  });
  it("never throws on junk", () => {
    expect(sanitizeHttpUrl("not a url")).toBe("not a url");
  });
});

describe("proofWarning (audit 2026-09-23)", () => {
  it("warns on high/critical without proof", () => {
    expect(proofWarning("critical", "some GET 200 output", "")).toContain("TANPA bukti poc/retest");
    expect(proofWarning("high", "steps...", "")).toContain("TANPA bukti");
  });
  it("silent with poc/retest evidence, retest_url, or low severity", () => {
    expect(proofWarning("critical", "poc_verify 3/3 STABIL", "")).toBe("");
    expect(proofWarning("high", "nothing", "http://lab/x")).toBe("");
    expect(proofWarning("medium", "nothing", "")).toBe("");
    expect(proofWarning("low", "nothing", "")).toBe("");
  });
});
