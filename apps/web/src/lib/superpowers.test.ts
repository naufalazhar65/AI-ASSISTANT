import { describe, it, expect } from "vitest";
import { brainHost, brainPathKey, brainParamNames } from "./targetBrain";
import { retestCaseId, retestHost, retestVerdict } from "./retest";
import { parseMatrixSpec, matrixGranted, matrixSame, matrixFindings } from "./authMatrix";
import { analyzeTaint, TAINT_SOURCES, TAINT_SINKS } from "./domTaint";
import { learnClassify, learnTech, learnEndpointStyle, learnExtract } from "./learning";

describe("targetBrain pure helpers", () => {
  it("brainHost extracts hostname from url/host forms", () => {
    expect(brainHost("https://lab.example.com/api/x?id=1")).toBe("lab.example.com");
    expect(brainHost("LAB.Example.com")).toBe("lab.example.com");
    expect(brainHost("http://127.0.0.1:4010/x")).toBe("127.0.0.1");
    expect(brainHost("")).toBe("");
    expect(brainHost("not a url ??")).toBe("");
  });

  it("brainPathKey keeps path + sorted param names only", () => {
    expect(brainPathKey("https://x.tld/api/dokumen?id=2&sort=asc")).toBe("/api/dokumen?id&sort");
    expect(brainPathKey("https://x.tld/page")).toBe("/page");
    expect(brainPathKey("junk")).toBe("");
  });

  it("brainParamNames returns sorted unique query keys", () => {
    expect(brainParamNames("https://x.tld/p?b=1&a=2&b=3")).toEqual(["a", "b"]);
    expect(brainParamNames("https://x.tld/p")).toEqual([]);
  });
});

describe("retest suite helpers", () => {
  it("retestCaseId is stable and slug-safe", () => {
    const a = retestCaseId("BOLA /api/dokumen", "https://x.tld/api/dokumen?id=1");
    const b = retestCaseId("BOLA /api/dokumen", "https://x.tld/api/dokumen?id=1");
    expect(a).toBe(b);
    expect(a.startsWith("R-")).toBe(true);
    expect(a).not.toMatch(/[^A-Za-z0-9-]/);
  });

  it("retestHost extracts host", () => {
    expect(retestHost("https://a.b.tld/x")).toBe("a.b.tld");
    expect(retestHost("bad")).toBe("");
  });

  it("retestVerdict: vulnerable when signature matches, patched when not, error on fetch error", () => {
    const c = { expect_contains: "secret-doc", expect_status: 200 };
    expect(retestVerdict(c, { status: 200, body: "…Secret-Doc here…" })).toBe("vulnerable");
    expect(retestVerdict(c, { status: 403, body: "forbidden" })).toBe("patched");
    expect(retestVerdict(c, { status: 200, body: "other data" })).toBe("patched");
    expect(retestVerdict(c, { status: 0, body: "", error: "ECONNREFUSED" })).toBe("error");
    // no assertions → 2xx counts as still-vulnerable signal
    expect(retestVerdict({ expect_contains: "", expect_status: 0 }, { status: 200, body: "x" })).toBe("vulnerable");
    expect(retestVerdict({ expect_contains: "", expect_status: 0 }, { status: 500, body: "x" })).toBe("patched");
  });
});

describe("auth matrix helpers", () => {
  it("parseMatrixSpec validates lists and bounds", () => {
    const ok = parseMatrixSpec({ endpoints: "/a,/b", sessions: "admin, user", granted_status_max: "399" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.spec.endpoints).toEqual(["/a", "/b"]);
      expect(ok.spec.sessions).toEqual(["admin", "user"]);
      expect(ok.spec.grantedStatusMax).toBe(399);
    }
    expect(parseMatrixSpec({ endpoints: "", sessions: "a" }).ok).toBe(false);
    expect(parseMatrixSpec({ endpoints: "/a", sessions: "" }).ok).toBe(false);
    expect(parseMatrixSpec({ endpoints: "/a", sessions: "a", granted_status_max: 999 }).ok).toBe(false);
  });

  it("matrixGranted treats errors as denied and honors the granted ceiling", () => {
    expect(matrixGranted({ status: 200, error: undefined }, 399)).toBe(true);
    expect(matrixGranted({ status: 403, error: undefined }, 399)).toBe(false);
    expect(matrixGranted({ status: 302, error: undefined }, 200)).toBe(false);
    expect(matrixGranted({ status: 0, error: "boom" }, 399)).toBe(false);
  });

  it("matrixSame compares status and body size with tolerance", () => {
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 200, len: 1005, digest: "" })).toBe(true);
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 200, len: 2000, digest: "" })).toBe(false);
    expect(matrixSame({ status: 200, len: 1000, digest: "" }, { status: 404, len: 1000, digest: "" })).toBe(false);
  });

  it("matrixFindings flags anonymous-access and cross-role, not uniform", () => {
    const spec = { endpoints: ["/api/dokumen?id=1", "/safe"], sessions: ["admin", "guest"] };
    const rows = [
      { endpoint: "/api/dokumen?id=1", session: "", status: 200, len: 500, digest: "" },
      { endpoint: "/api/dokumen?id=1", session: "admin", status: 200, len: 500, digest: "" },
      { endpoint: "/api/dokumen?id=1", session: "guest", status: 200, len: 505, digest: "" },
      { endpoint: "/safe", session: "", status: 403, len: 10, digest: "" },
      { endpoint: "/safe", session: "admin", status: 200, len: 100, digest: "" },
      { endpoint: "/safe", session: "guest", status: 403, len: 10, digest: "" },
    ];
    const f = matrixFindings(spec, rows);
    const dokumen = f.find((x) => x.endpoint === "/api/dokumen?id=1");
    expect(dokumen?.kind).toBe("anonymous-access");
    expect(f.some((x) => x.endpoint === "/api/dokumen?id=1" && x.kind === "cross-role")).toBe(true);
    const safe = f.find((x) => x.endpoint === "/safe");
    expect(safe?.kind).toBe("uniform");
    expect(safe?.severity).toBe("info");
  });
});

describe("dom taint analysis", () => {
  it("has sources and sinks defined", () => {
    expect(TAINT_SOURCES.length).toBeGreaterThan(4);
    expect(TAINT_SINKS.length).toBeGreaterThan(4);
  });

  it("flags unsanitized source→sink flow", () => {
    const js = `
      const q = location.hash.slice(1);
      document.getElementById("out").innerHTML = q;
    `;
    const flows = analyzeTaint(js, "app.js");
    expect(flows.length).toBe(1);
    expect(flows[0].source).toBe("location.hash");
    expect(flows[0].sink).toBe("innerHTML");
    expect(flows[0].sanitized).toBe(false);
  });

  it("does not flag sanitized flow or unrelated sinks", () => {
    const clean = "const q = encodeURIComponent(location.hash.slice(1));\n      el.textContent = q;";
    expect(analyzeTaint(clean, "clean.js").length).toBe(0);
    const noSink = "const q = location.hash;\n      console.log(q);";
    expect(analyzeTaint(noSink, "nosink.js").length).toBe(0);
  });

  it("flags eval on postMessage data (classic bypass)", () => {
    const js = 'window.addEventListener("message", (e) => {\n        const cmd = e.data;\n        eval(cmd);\n      });';
    const flows = analyzeTaint(js, "m.js");
    expect(flows.some((f) => f.sink === "eval" && f.variable === "cmd")).toBe(true);
  });
});

describe("disclosed-report learning", () => {
  it("classifies vuln class from text", () => {
    expect(learnClassify("IDOR in /api/v1/orders allowed me to read other users' orders")).toBe("idor");
    expect(learnClassify("Blind SSRF via the import feature")).toBe("ssrf");
    expect(learnClassify("JWT alg none authentication bypass")).toBe("jwt");
    expect(learnClassify("nothing special here")).toBe("info-disclosure");
  });

  it("extracts tech and endpoint style", () => {
    expect(learnTech("the Laravel app leaked env via nextjs page")).toContain("laravel");
    expect(learnEndpointStyle("found at /api/v2/users/9821 leaking email")).toBe("/api/v2/users/9821");
  });

  it("learnExtract builds a bounded pattern", () => {
    const p = learnExtract("Broken Object Level Authorization on /api/orders\nBypass: changed the id param to another tenant's id. Impact: full data read.", "https://example.com/writeup");
    expect(p).not.toBeNull();
    if (p) {
      expect(p.vulnClass).toBe("bola");
      expect(p.endpointStyle).toContain("/api/orders");
      expect(p.source).toBe("https://example.com/writeup");
      expect(p.trick.length).toBeGreaterThan(0);
    }
  });

  it("learnExtract rejects tiny texts", () => {
    expect(learnExtract("too short", "x")).toBeNull();
  });
});
