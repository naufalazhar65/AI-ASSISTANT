// Unit tests for domXssProve pure helpers (no browser).
import { describe, expect, it } from "vitest";
import {
  buildAttemptUrl,
  classifyDomXss,
  DOM_SOURCES,
  DYN_XSS_PAYLOAD,
  staticSourceKey,
} from "./domXssProve";

describe("DYN_XSS_PAYLOAD", () => {
  it("is dual-nature: JS statement plus HTML marker with handler", () => {
    expect(DYN_XSS_PAYLOAD).toContain("window.__miaXssDyn=1");
    expect(DYN_XSS_PAYLOAD).toContain('id="miaxdyn"');
    expect(DYN_XSS_PAYLOAD).toContain("onerror");
  });
});

describe("buildAttemptUrl", () => {
  it("hash appends the RAW payload (no URL-API encoding of < >)", () => {
    const u = buildAttemptUrl("http://h/app", "hash", DYN_XSS_PAYLOAD);
    expect(u).toBe(`http://h/app#${DYN_XSS_PAYLOAD}`);
    expect(u).toContain("<img");
  });
  it("hash replaces any existing fragment", () => {
    expect(buildAttemptUrl("http://h/app#old", "hash", "P")).toBe("http://h/app#P");
  });
  it("search appends a raw query param, preserving existing query", () => {
    expect(buildAttemptUrl("http://h/app", "search", "P")).toBe("http://h/app?mia=P");
    expect(buildAttemptUrl("http://h/app?a=1", "search", "P", "q")).toBe("http://h/app?a=1&q=P");
  });
  it("search sanitizes a hostile param name", () => {
    expect(buildAttemptUrl("http://h/app", "search", "P", "a b/c")).toBe("http://h/app?mia=P");
  });
  it("referrer returns the bare page URL (two-step nav handles the rest)", () => {
    expect(buildAttemptUrl("http://h/app#frag", "referrer", "P")).toBe("http://h/app");
  });
});

describe("classifyDomXss", () => {
  it("PROVEN beats injected-only", () => {
    expect(
      classifyDomXss([
        { source: "hash", exec: false, injected: true, note: "" },
        { source: "search", exec: true, injected: true, note: "" },
      ])
    ).toEqual({ verdict: "PROVEN", source: "search" });
  });
  it("INJECTED_ONLY without execution", () => {
    expect(
      classifyDomXss([{ source: "hash", exec: false, injected: true, note: "" }]).verdict
    ).toBe("INJECTED_ONLY");
  });
  it("NOT_CONFIRMED on empty/negative", () => {
    expect(classifyDomXss([]).verdict).toBe("NOT_CONFIRMED");
    expect(
      classifyDomXss([{ source: "hash", exec: false, injected: false, note: "x" }]).verdict
    ).toBe("NOT_CONFIRMED");
  });
});

describe("staticSourceKey", () => {
  it("maps static labels to attempt keys", () => {
    expect(staticSourceKey("location.hash")).toBe("hash");
    expect(staticSourceKey("location.search")).toBe("search");
    expect(staticSourceKey("document.referrer")).toBe("referrer");
    expect(staticSourceKey("postMessage event.data")).toBe("postmessage");
    expect(staticSourceKey("window.name")).toBe("windowname");
    expect(staticSourceKey("location.href")).toBe("hash");
    expect(staticSourceKey("document.cookie")).toBeNull();
  });
});

describe("DOM_SOURCES", () => {
  it("covers the five attempted sources, bounded", () => {
    expect([...DOM_SOURCES].sort()).toEqual(
      ["hash", "postmessage", "referrer", "search", "windowname"].sort()
    );
  });
});
