// pathTraversal.test.ts — pure helpers of the path_traversal prover.
// Runner-level behavior (live toy server, scope guard, dispatch) lives in
// verify.ts; here we lock the pure functions that decide markers/leads.
import { describe, expect, it } from "vitest";
import {
  applyPayload,
  isAnomaly,
  phpFilterDecode,
  TRAVERSAL_PARAMS,
  traversalMarker,
  type Probe,
} from "./pathTraversal";

describe("phpFilterDecode", () => {
  it("decodes base64 php://filter bodies to raw bytes (latin1 1:1)", () => {
    const b64 = Buffer.from("<?php echo 1; ?>", "latin1").toString("base64");
    expect(phpFilterDecode(b64)).toBe("<?php echo 1; ?>");
  });

  it("returns '' for HTML pages (never base64 charset)", () => {
    expect(phpFilterDecode("<html><body>hello</body></html>")).toBe("");
  });

  it("returns '' for short / junk input", () => {
    expect(phpFilterDecode("abc")).toBe("");
    expect(phpFilterDecode("!!!not base64!!!")).toBe("");
  });

  it("tolerates whitespace around the encoded payload", () => {
    const b64 = Buffer.from("<?xml version='1.0'?>", "latin1").toString("base64");
    expect(phpFilterDecode(`\n  ${b64}  \n`)).toBe("<?xml version='1.0'?>");
  });
});

describe("traversalMarker", () => {
  const passwd = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:";
  const winini = "[fonts]\n[extensions]\n[mci extensions]\n[mail]\n";

  it("flags /etc/passwd content when absent from the baseline", () => {
    expect(traversalMarker(passwd, "404 Not Found")).toBe("passwd");
  });

  it("flags the BSD/macOS passwd dialect (spaced GECOS) too", () => {
    // macOS: root:*:0:0:System Administrator:/var/root:/bin/sh — a `\S*` GECOS
    // matcher silently missed every BSD-family passwd (live darwin verify).
    const bsd = "root:*:0:0:System Administrator:/var/root:/bin/sh\ndaemon:*:1:1:System Services:/var/root:/usr/bin/false";
    expect(traversalMarker(bsd, "<html>")).toBe("passwd");
  });

  it("stays silent when the baseline already prints passwd content", () => {
    expect(traversalMarker(passwd, passwd.substring(0, 40))).toBeNull();
  });

  it("flags win.ini markers ([fonts]/[extensions])", () => {
    expect(traversalMarker(winini, "<html>")).toBe("winini");
  });

  it("flags php://filter decoded source (<?php)", () => {
    const b64 = Buffer.from("<?php $db = new PDO(...); ?>", "latin1").toString("base64");
    expect(traversalMarker(b64, "<html>")).toBe("php");
  });

  it("returns null for benign pages", () => {
    expect(traversalMarker("<html><body>home</body></html>", "<html>")).toBeNull();
  });
});

describe("applyPayload", () => {
  const u = new URL("http://127.0.0.1:4010/read?file=report.pdf&lang=id");

  it("GET: sets the param on a COPY of the URL (no mutation)", () => {
    const r = applyPayload(u, "file", "../../../../etc/passwd", "GET");
    const c = new URL(r.url);
    expect(c.searchParams.get("file")).toBe("../../../../etc/passwd");
    expect(c.searchParams.get("lang")).toBe("id");
    expect(u.searchParams.get("file")).toBe("report.pdf"); // original untouched
  });

  it("POST: moves query params into the body and keeps them keyed", () => {
    const r = applyPayload(u, "file", "../../../../etc/passwd", "POST");
    const url = new URL(r.url);
    expect(url.searchParams.has("file")).toBe(false);
    const sp = new URLSearchParams(r.body);
    expect(sp.get("file")).toBe("../../../../etc/passwd");
    expect(sp.get("lang")).toBe("id");
  });
});

describe("isAnomaly", () => {
  const base: Probe = { status: 200, body: "x".repeat(100), ms: 5 };

  it("true on status change", () => {
    expect(isAnomaly(base, { status: 500, body: "x".repeat(100), ms: 5 })).toBe(true);
  });

  it("true on size shift > 60 bytes", () => {
    expect(isAnomaly(base, { status: 200, body: "x".repeat(400), ms: 5 })).toBe(true);
  });

  it("false when response matches baseline closely", () => {
    expect(isAnomaly(base, { status: 200, body: "x".repeat(120), ms: 6 })).toBe(false);
  });

  it("false on network error / status 0", () => {
    expect(isAnomaly(base, { status: 0, body: "", ms: 5000, error: "fetch failed" })).toBe(false);
  });
});

describe("TRAVERSAL_PARAMS", () => {
  it("covers the common file/url parameter names", () => {
    for (const n of ["file", "path", "page", "include", "url", "template", "doc", "download"]) {
      expect(TRAVERSAL_PARAMS).toContain(n);
    }
  });

  it("is a bounded, non-empty list", () => {
    expect(TRAVERSAL_PARAMS.length).toBeGreaterThan(5);
    expect(TRAVERSAL_PARAMS.length).toBeLessThan(25);
    expect(new Set(TRAVERSAL_PARAMS).size).toBe(TRAVERSAL_PARAMS.length);
  });
});