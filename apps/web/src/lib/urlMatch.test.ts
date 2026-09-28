import { describe, it, expect } from "vitest";
import { hostOfUrl, pathOfUrl, urlWitnessesUrl, pickAutoEvidence, argsMentionPath, normalisePath } from "./urlMatch";

describe("hostOfUrl", () => {
  it("reads the host of an absolute URL", () => {
    expect(hostOfUrl("https://lab.example:8443/api/x?q=1")).toBe("lab.example:8443");
  });

  it("falls back to the leading token of a bare target", () => {
    expect(hostOfUrl("lab.example/api/x")).toBe("lab.example");
  });
});

describe("pathOfUrl", () => {
  it("returns the pathname without the query", () => {
    expect(pathOfUrl("https://lab.example/api/dokumen?id=4")).toBe("/api/dokumen");
  });

  it("returns the path of a bare relative target", () => {
    expect(pathOfUrl("/api/dokumen?id=4")).toBe("/api/dokumen");
  });
});

describe("urlWitnessesUrl", () => {
  it("lets a host-level record witness any path on that host", () => {
    expect(urlWitnessesUrl("https://lab.example/", "https://lab.example/api/login")).toBe(true);
  });

  it("refuses a record from a different host outright", () => {
    expect(urlWitnessesUrl("https://other.example/api/x", "https://lab.example/api/x")).toBe(false);
  });

  it("refuses a path-level record for an endpoint the finding never mentions", () => {
    // This is the audit §4.1 case: a /api/login finding must not ship
    // /api/dokumen?id=4 as its evidence.
    expect(urlWitnessesUrl("https://lab.example/api/dokumen?id=4", "https://lab.example/api/login")).toBe(false);
  });

  it("accepts any host request as evidence for a HOST-level finding (no path at all)", () => {
    // verify.ts exercises this exact flow: addFinding(target="example.com") with
    // one recorded request. Tightening the path rule without this branch made
    // the auto-attach silently stop working.
    expect(urlWitnessesUrl("https://example.com/api/user/1", "example.com")).toBe(true);
  });

  it("accepts a path-level record once the finding references that path", () => {
    expect(
      urlWitnessesUrl("https://lab.example/api/dokumen?id=4", "https://lab.example/api/login", "GET /api/dokumen?id=4 -> 200")
    ).toBe(true);
  });
});

describe("pickAutoEvidence", () => {
  const records = [
    { url: "https://lab.example/api/dokumen?id=4", status: 200 },
    { url: "https://lab.example/api/login", status: 200 },
    { url: "https://lab.example/", status: 200 },
  ];

  it("prefers an exact path match over a host-level record", () => {
    const pick = pickAutoEvidence(records, "https://lab.example/api/login");
    expect(pick?.url).toBe("https://lab.example/api/login");
  });

  it("falls back to a host-level record when no path matches", () => {
    const pick = pickAutoEvidence([records[2], records[0]], "https://lab.example/api/login");
    expect(pick?.url).toBe("https://lab.example/");
  });

  it("returns null rather than cite a record from another host", () => {
    expect(pickAutoEvidence([{ url: "https://other.example/api/x" }], "https://lab.example/api/x")).toBeNull();
  });

  it("returns null when there is no history at all", () => {
    expect(pickAutoEvidence([], "https://lab.example/api/x")).toBeNull();
  });

  it("scans newest-first so the latest matching record wins", () => {
    const pick = pickAutoEvidence(
      [
        { url: "https://lab.example/api/login" },
        { url: "https://lab.example/api/login", status: 500 },
      ],
      "https://lab.example/api/login"
    );
    expect(pick?.status).toBe(500);
  });

  it("does not cite anything when the finding has no target", () => {
    expect(pickAutoEvidence(records, "")).toBeNull();
  });
});

// Live origin: turn 17:12. The ask named `/login`; the model probed
// `/api/login`. The old membership test was a raw `.includes()` over the whole
// serialised args, so `/login` was found INSIDE `/api/login`, the path was marked
// "covered", and the completion-claim correction silently never fired in
// production. This suite locks the EXACT rule so that shape cannot come back.
describe("argsMentionPath — a probe must cover ONLY the path it actually touched", () => {
  const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

  it("a probe of /api/login does NOT cover /login (the live 17:12 bug)", () => {
    expect(argsMentionPath({ url: `${LAB}/api/login`, method: "POST" }, "/login")).toBe(false);
  });

  it("a probe of /login DOES cover /login", () => {
    expect(argsMentionPath({ url: `${LAB}/login`, method: "GET" }, "/login")).toBe(true);
  });

  it("a probe of /api/login DOES cover /api/login", () => {
    expect(argsMentionPath({ url: `${LAB}/api/login`, method: "POST" }, "/api/login")).toBe(true);
  });

  it("a free-text field that merely mentions a path does NOT cover it", () => {
    // A `reason`/`notes` argument naming the endpoint is not evidence it was
    // touched — the same class as the wrong-endpoint auto-evidence.
    expect(argsMentionPath({ reason: "POST /api/login to test the login flow" }, "/login")).toBe(false);
    expect(argsMentionPath({ notes: "prefix/login is unrelated" }, "/login")).toBe(false);
  });

  it("normalises query, trailing slash, double slash and case", () => {
    expect(argsMentionPath({ url: `${LAB}/login?id=1` }, "/login")).toBe(true);
    expect(argsMentionPath({ url: `${LAB}/login/` }, "/login")).toBe(true);
    expect(argsMentionPath({ url: `${LAB}//login` }, "/login")).toBe(true);
    expect(argsMentionPath({ url: `${LAB}/LOGIN` }, "/login")).toBe(true);
  });

  it("reads a scheme-less host/path target", () => {
    expect(argsMentionPath({ target: "cozy-kangaroo-42f2e0.netlify.app/api/login" }, "/api/login")).toBe(true);
  });

  it("finds a path nested anywhere in the args object", () => {
    expect(argsMentionPath({ headers: { referer: "x" }, urls: ["a", `${LAB}/login`] }, "/login")).toBe(true);
  });

  it("host-level / is covered by any absolute URL on the host", () => {
    expect(argsMentionPath({ url: `${LAB}/api/login` }, "/")).toBe(true);
    expect(argsMentionPath({ url: "https://elsewhere.example/x" }, "/")).toBe(true);
  });

  it("is silent — never throws — on null, empty and non-string args", () => {
    expect(argsMentionPath(null, "/login")).toBe(false);
    expect(argsMentionPath(undefined, "/login")).toBe(false);
    expect(argsMentionPath({}, "/login")).toBe(false);
    expect(argsMentionPath({ a: 1, b: null }, "")).toBe(false);
  });

  it("normalisePath collapses the shapes the tests above rely on", () => {
    expect(normalisePath("//a//b/")).toBe("/a/b");
    expect(normalisePath("/Login?id=1")).toBe("/login");
    expect(normalisePath("")).toBe("/");
  });
});

// The guard hands `arguments` over as a raw JSON STRING; several tests above pass
// an object. That asymmetry hid a real regression, so the string form is locked
// explicitly — an object-only test suite is a suite that can pass while
// production fails.
describe("argsMentionPath — the same args as a raw JSON string", () => {
  const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
  const enc = (o: unknown) => JSON.stringify(o);

  it("behaves identically for object and string args", () => {
    for (const p of ["/login", "/api/login", "/"]) {
      const obj = { url: `${LAB}/login`, method: "GET" };
      expect(argsMentionPath(enc(obj), p)).toBe(argsMentionPath(obj, p));
    }
  });

  it("a host-level ask is covered by a URL buried in JSON args (TeamCity turn)", () => {
    expect(argsMentionPath(enc({ url: "https://lab/login.html", method: "GET" }), "https://lab")).toBe(true);
  });
});
