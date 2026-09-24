// Unit tests for protoPollute pure helpers (no network).
import { describe, expect, it } from "vitest";
import { buildServerPayloads, classifyServer, classifyClient, POLLUTE_KEYS, MARK } from "./protoPollute";

const PROBE = (over: Partial<{ status: number; body: string; error?: string }>) =>
  ({ status: 200, body: '{"ok":true}', headers: {}, ms: 5, ...over });

describe("buildServerPayloads", () => {
  it("covers query + JSON variants and bounds count", () => {
    const m = buildServerPayloads("http://127.0.0.1:4010/api/profile", "prefs");
    expect(m.length).toBe(5);
    expect(m.some((a) => a.url.includes("__proto__%5B"))).toBe(true);
    expect(m.some((a) => a.body?.includes("__proto__"))).toBe(true);
    expect(m.every((a) => /^https?:\/\//.test(a.url))).toBe(true);
  });

  it("carries an existing query string", () => {
    const m = buildServerPayloads("http://127.0.0.1:4010/api/profile?x=1", "prefs");
    expect(m[0].url).toContain("x=1");
    expect(m[0].url).toContain("__proto__");
  });

  it("sanitizes the param name", () => {
    const m = buildServerPayloads("http://127.0.0.1:4010/x", "bad param!@#");
    expect(m[0].url).toContain("badparam");
  });

  it("returns [] on unparseable URL", () => {
    expect(buildServerPayloads("nope", "x")).toEqual([]);
  });

  it("marker key set is the classic trio", () => {
    expect(POLLUTE_KEYS).toContain("__proto__");
    expect(POLLUTE_KEYS).toContain("constructor.prototype");
  });
});

describe("classifyServer", () => {
  const BASE = PROBE({ body: '{"user":{"name":"mia"}}' });

  it("marker in a later response = STRONG", () => {
    const sig = classifyServer(BASE, PROBE({ body: `{"user":{"name":"mia","${MARK}":"x"}}` }), "prefs");
    expect(sig[0]).toContain("STRONG");
  });

  it("error naming __proto__ = WEAK (reached a parser)", () => {
    const sig = classifyServer(BASE, PROBE({ status: 400, body: '{"error":"invalid key __proto__"}' }), "prefs");
    expect(sig[0]).toContain("WEAK");
  });

  it("new 500 vs baseline = WEAK", () => {
    const sig = classifyServer(BASE, PROBE({ status: 500, body: "TypeError: Cannot create property" }), "prefs");
    expect(sig[0]).toContain("WEAK");
    expect(sig[0]).toContain("500");
  });

  it("no signal stays honest", () => {
    const sig = classifyServer(BASE, PROBE({ body: '{"user":{"name":"mia"}}' }), "prefs");
    expect(sig[0]).toContain("tidak ada indikasi");
  });

  it("network failure reports honestly", () => {
    expect(classifyServer(BASE, PROBE({ status: 0, error: "x" }), "prefs")).toEqual(["gagal jaringan"]);
  });
});

describe("classifyClient", () => {
  it("source + merge sink = client lead", () => {
    const sig = classifyClient("const cfg = deepMerge(DEFAULTS, JSON.parse(location.hash.slice(1)));");
    expect(sig[0]).toContain("CLIENT-LEAD");
    expect(sig[0]).toContain("CWE-1321");
  });

  it("sink without source = hardening note only", () => {
    const sig = classifyClient("const out = merge(defaults, opts);");
    expect(sig[0]).toContain("hardening");
    expect(sig[0]).not.toContain("CLIENT-LEAD");
  });

  it("nothing = no output", () => {
    expect(classifyClient("console.log('hi');")).toEqual([]);
  });

  it("Object.assign sink is recognized", () => {
    const sig = classifyClient("Object.assign(config, params); Object.assign(config2, hash);");
    expect(sig[0]).toContain("Object.assign");
  });
});

describe("MARK", () => {
  it("is a safe identifier-like marker", () => {
    expect(MARK).toMatch(/^[a-z_]+$/);
    expect(MARK).not.toBe("constructor");
  });
});
