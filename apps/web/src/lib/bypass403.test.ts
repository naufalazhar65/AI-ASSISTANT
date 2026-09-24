// Unit tests for bypass403 pure helpers (no network).
import { describe, expect, it } from "vitest";
import { buildBypassMatrix, denyDigest, classifyBypass } from "./bypass403";

const PROBE = (over: Partial<{ status: number; body: string; error?: string; headers: Record<string, string> }>) =>
  ({ status: 403, body: "denied", headers: {}, ms: 5, ...over });

describe("buildBypassMatrix", () => {
  it("covers path/header/verb/body/host kinds", () => {
    const m = buildBypassMatrix("http://127.0.0.1:4010/admin");
    const kinds = new Set(m.map((a) => a.kind));
    expect(kinds.has("path")).toBe(true);
    expect(kinds.has("header")).toBe(true);
    expect(kinds.has("verb")).toBe(true);
    expect(kinds.has("body")).toBe(true);
    expect(kinds.has("host")).toBe(true);
    expect(m.length).toBeLessThanOrEqual(20);
    expect(m.every((a) => /^https?:\/\//.test(a.url) || a.url === "http://127.0.0.1:4010/admin")).toBe(true);
  });

  it("keeps the query string on header tricks (X-Original-URL carries it)", () => {
    const m = buildBypassMatrix("http://127.0.0.1:4010/admin?id=5");
    const xo = m.find((a) => a.name === "X-Original-URL");
    expect(xo).toBeTruthy();
    expect(xo!.headers?.["x-original-url"]).toBe("/admin?id=5");
  });

  it("returns [] on unparseable URL", () => {
    expect(buildBypassMatrix("not a url")).toEqual([]);
  });

  it("normalizes a trailing-slash target once", () => {
    const m = buildBypassMatrix("http://127.0.0.1:4010/admin/");
    const ts = m.find((a) => a.name === "trailing slash");
    expect(ts?.url).toBe("http://127.0.0.1:4010/admin/");
    // dot-segments are fetch-normalized away, so %2e variants stand in
    const te = m.find((a) => a.name === "trailing %2e");
    expect(te?.url).toBe("http://127.0.0.1:4010/admin%2e");
  });
});

describe("denyDigest", () => {
  it("normalizes UUIDs and long numbers", () => {
    expect(denyDigest("req 8f14e45f-ceea-467f-a529-123456789abc at 1727123456789")).toBe(denyDigest("req U at N"));
    expect(denyDigest("denied")).toBe("denied");
  });
});

describe("classifyBypass", () => {
  const BASE = PROBE({ status: 403, body: "<h1>403 forbidden</h1> request id 12345678" });

  it("2xx with a different body = BYPASS LEAD", () => {
    const attempt = buildBypassMatrix("http://127.0.0.1:4010/admin")[0];
    const sig = classifyBypass(BASE, PROBE({ status: 200, body: "<h1>Admin dashboard</h1>" }), attempt);
    expect(sig[0]).toContain("BYPASS LEAD");
  });

  it("2xx with the SAME body as the deny page is NOT a bypass (SPA catch-all)", () => {
    const attempt = buildBypassMatrix("http://127.0.0.1:4010/admin")[0];
    const sig = classifyBypass(BASE, PROBE({ status: 200, body: "<h1>403 forbidden</h1> request id 99999999" }), attempt);
    expect(sig[0]).toContain("SAMA");
    expect(sig[0]).not.toContain("BYPASS");
  });

  it("echo guard: reflecting the trick path back is not content", () => {
    const attempt = { name: "trailing ;", kind: "path" as const, url: "http://127.0.0.1:4010/admin;", method: "GET" };
    const sig = classifyBypass(BASE, PROBE({ status: 200, body: "cannot serve /admin; right now" }), attempt);
    expect(sig[0]).toContain("echo");
  });

  it("still 403 = no signal, not an error", () => {
    const attempt = buildBypassMatrix("http://127.0.0.1:4010/admin")[0];
    expect(classifyBypass(BASE, PROBE({ status: 403, body: "denied again" }), attempt)).toEqual([]);
  });

  it("external redirect is surfaced, not swallowed", () => {
    const attempt = buildBypassMatrix("http://127.0.0.1:4010/admin")[0];
    const sig = classifyBypass(BASE, PROBE({ status: 302, body: "", headers: { location: "http://evil.example/x" } }), attempt);
    expect(sig[0]).toContain("redirect eksternal");
  });

  it("network failure reports honestly", () => {
    const attempt = buildBypassMatrix("http://127.0.0.1:4010/admin")[0];
    expect(classifyBypass(BASE, PROBE({ status: 0, error: "ECONNREFUSED" }), attempt)).toEqual(["gagal jaringan"]);
  });
});
