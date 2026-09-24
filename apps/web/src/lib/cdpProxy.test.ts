// Unit tests for cdpProxy pure helpers (no network, no Chrome).
import { describe, expect, it } from "vitest";
import { requestKey, summarizeRequests, patchScript, drainScript } from "./cdpProxy";

describe("requestKey", () => {
  it("strips query VALUES, keeps key names", () => {
    expect(requestKey("https://x.test/api/list?token=SECRET&id=42&page=2")).toBe(
      "/api/list?token&id&page"
    );
  });
  it("caps the number of query keys", () => {
    const u = `https://x.test/a?${Array.from({ length: 20 }, (_, i) => `p${i}=1`).join("&")}`;
    const k = requestKey(u);
    expect(k.split("&").length).toBeLessThanOrEqual(12);
  });
  it("survives a non-URL (falls back to pre-? part)", () => {
    expect(requestKey("not a url?x=1")).toBe("not a url");
  });
  it("bare path stays bare", () => {
    expect(requestKey("https://x.test/api/health")).toBe("/api/health");
  });
  it("keyless-looking key (dot/space in param name) keeps its query on re-parse", () => {
    // the brain re-parses requestKey output; a key with a dot would otherwise
    // be treated as a bare path and LOSE its query marker
    const k = requestKey("https://x.test/a?user.name=SECRET");
    expect(k).toBe("/a?user.name");
    expect(new URL(`https://x.test${k}`).search).toBe("?user.name");
  });
});

describe("summarizeRequests", () => {
  it("groups by host, counts duplicates, shows ×N", () => {
    const reqs = [
      { method: "GET", url: "https://a.test/api/x?z=1", kind: "fetch" as const },
      { method: "GET", url: "https://a.test/api/x?z=2", kind: "fetch" as const }, // same keys → same signature
      { method: "POST", url: "https://a.test/api/login", kind: "xhr" as const },
      { method: "GET", url: "https://b.test/y", kind: "fetch" as const },
    ];
    const out = summarizeRequests(reqs);
    expect(out.length).toBe(2);
    expect(out[0].host).toBe("a.test");
    expect(out[0].total).toBe(3);
    expect(out[0].lines.some((l) => l.includes("GET /api/x?z ×2"))).toBe(true);
    expect(out[0].lines.some((l) => l.includes("POST /api/login"))).toBe(true);
  });
  it("empty input → empty summary", () => {
    expect(summarizeRequests([])).toEqual([]);
  });
  it("same path different query keys = different signatures", () => {
    const out = summarizeRequests([
      { method: "GET", url: "https://a.test/x?id=1", kind: "fetch" },
      { method: "GET", url: "https://a.test/x?q=2", kind: "fetch" },
    ]);
    expect(out[0].lines.length).toBe(2);
  });
});

describe("scripts", () => {
  it("patch script clamps seconds and entries, and is idempotence-aware", () => {
    const s = patchScript(9999, 99999);
    expect(s).toContain("window.__miaProxy");
    expect(s).toContain("ALREADY-ACTIVE");
    // clamped to MAX bounds (120s / 400 entries)
    expect(s).toMatch(/Date\.now\(\) \+ \d+ \* 1000/);
    expect(s).not.toContain("9999");
  });
  it("drain script deactivates and returns JSON array string", () => {
    const d = drainScript();
    expect(d).toContain("active = false");
    expect(d).toContain("JSON.stringify");
  });
  it("rec() is gated by active — post-drain traffic is NOT recorded", () => {
    const s = patchScript(30, 400);
    // the active check must come BEFORE the cap check inside rec()
    const recIdx = s.indexOf("const rec =");
    const activeIdx = s.indexOf("!W.active", recIdx);
    const capIdx = s.indexOf("W.reqs.length >=", recIdx);
    expect(activeIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(activeIdx);
  });
  it("patch script is syntactically valid JS (syntax-check via new Function)", () => {
    expect(() => new Function(patchScript(30, 400))).not.toThrow();
    expect(() => new Function(drainScript())).not.toThrow();
  });
});
