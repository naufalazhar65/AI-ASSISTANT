// Unit tests for uploadFuzz pure helpers + runner (no network).
import { describe, expect, it } from "vitest";
import { extractFileUrl, uploadFuzz, uploadVectors, type FetchFn } from "./uploadFuzz";

describe("uploadVectors + extractFileUrl", () => {
  it("bounded benign matrix, no server-config writes", () => {
    const vs = uploadVectors();
    expect(vs.length).toBeLessThanOrEqual(8);
    const names = vs.map((v) => v.filename.toLowerCase()).join(" ");
    expect(names).not.toContain(".htaccess");
    expect(vs.every((v) => !/webshell|shell\.php[^5l]|eval\(|system\(/i.test(v.body))).toBe(true);
  });
  it("extracts file URL from JSON keys, Location, or quoted paths", () => {
    expect(extractFileUrl('{"url":"/uploads/a.jpg"}', {})).toBe("/uploads/a.jpg");
    expect(extractFileUrl("nope", { location: "https://h/f.png" })).toBe("https://h/f.png");
    expect(extractFileUrl('saved to "/u/b.gif" ok', {})).toBe("/u/b.gif");
    expect(extractFileUrl("nothing here", {})).toBe("");
  });
});

describe("uploadFuzz runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await uploadFuzz("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await uploadFuzz("u", { url: "https://example.com/up" })).toMatch(/SCOPE/);
  });
  it("proves accessible bypass end-to-end via injected fetch", async () => {
    const fetchFn: FetchFn = async (url, init) => {
      const b = typeof init?.body === "string" ? init.body : "";
      if (url === "http://127.0.0.1:4010/up" && b.includes("shell.jpg.php")) {
        return { status: 200, body: '{"url":"/u/shell.jpg.php"}', headers: {} };
      }
      if (url === "http://127.0.0.1:4010/u/shell.jpg.php") {
        return { status: 200, body: "mia-upload-probe-marker-7f3a\nplain", headers: {} };
      }
      return { status: 403, body: "", headers: {} };
    };
    const out = await uploadFuzz("u", { url: "http://127.0.0.1:4010/up", vectors: ["double-ext"], fetchFn });
    expect(out).toContain("TERAKSES");
    expect(out).toContain("1 LEAD");
  });
  it("honest negative when everything rejected", async () => {
    const out = await uploadFuzz("u", {
      url: "http://127.0.0.1:4010/up", vectors: ["phtml"],
      fetchFn: async () => ({ status: 415, body: "", headers: {} }),
    });
    expect(out).toContain("Tidak ada bypass terbukti");
  });
});
