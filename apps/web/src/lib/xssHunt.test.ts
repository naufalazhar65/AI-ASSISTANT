// Unit tests for xssHunt pure helpers + runner (no network).
import { describe, expect, it } from "vitest";
import { breakoutFor, xssContext, xssHunt } from "./xssHunt";

describe("xssContext", () => {
  it("classifies html/attribute/script/comment/none", () => {
    expect(xssContext("<p>hi MARK123</p>", "MARK123")).toBe("html");
    expect(xssContext('<input value="MARK123">', "MARK123")).toBe("attribute");
    expect(xssContext("<script>var x='MARK123';</script>", "MARK123")).toBe("script");
    expect(xssContext("<!-- MARK123 -->", "MARK123")).toBe("comment");
    expect(xssContext("<p>hi</p>", "MARK123")).toBe("none");
  });
  it("script-close before marker is html, not script", () => {
    expect(xssContext("<script>var a=1;</script><p>MARK123</p>", "MARK123")).toBe("html");
  });
});

describe("breakoutFor", () => {
  it("one confirmer per context, none for none", () => {
    expect(breakoutFor("html", "m")).toBe("<b>m</b>");
    expect(breakoutFor("attribute", "m")).toContain("onfocus");
    expect(breakoutFor("script", "m")).toContain("alert");
    expect(breakoutFor("comment", "m")).toContain("svg");
    expect(breakoutFor("none", "m")).toBeNull();
  });
});

describe("xssHunt runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await xssHunt("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await xssHunt("u", { url: "https://example.com/" })).toMatch(/SCOPE/);
  });
  it("proves reflected + breakout + OAST via injected fetch", async () => {    const fetchFn = async (url: string, init?: { body?: string }) => {
      const b = typeof init?.body === "string" ? init.body : url;
      if (url.startsWith("http://127.0.0.1:4010/s?q=") || b.includes("q=")) {
        const v = new URL(url.startsWith("http") ? url : "http://x/" + url).searchParams.get("q")
          ?? /q=([^&]*)/.exec(b)?.[1] ?? "";
        const val = decodeURIComponent(v);
        return { status: 200, body: `<html><p>hasil: ${val}</p></html>` };
      }
      return { status: 200, body: "<html>static</html>" };
    };
    const out = await xssHunt("u", {
      url: "http://127.0.0.1:4010/s?q=hi", fetchFn,
      pollOast: async () => "🎣 OAST https://webhook.site/tok — 2 hit (1 BARU sejak cek terakhir):",
    });
    expect(out).toContain("REFLECT (html)");
    expect(out).toContain("BREAKOUT lolos");
    expect(out).toContain("BEACON OAST TERKONFIRMASI");
    expect(out).toContain("1 kandidat XSS kuat");
    // Live oastCreate (no callback given → auto-create hits webhook.site):
    // tolerate slow network, asserts stay strict.
  }, 20000);
  it("honest negative when nothing reflects", async () => {
    const out = await xssHunt("u", {
      url: "http://127.0.0.1:4010/s?q=hi",
      fetchFn: async () => ({ status: 200, body: "<html>static</html>" }),
    });
    expect(out).toContain("Tidak ada kandidat XSS kuat");
  }, 20000);
});
