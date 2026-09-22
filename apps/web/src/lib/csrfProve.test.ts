// Unit tests for csrfProve pure helpers (no network).
import { describe, expect, it } from "vitest";
import { csrfProve, formHasToken, parseForms, renderCsrfPoc, sameSitePosture } from "./csrfProve";

const PAGE = `<html><body>
<form action="/transfer" method="POST"><input name="amount" value="10"><input type="submit"></form>
<form action="/profile" method="post"><input type="hidden" name="csrf_token" value="abc"><input name="name"></form>
<form action="https://evil.example/x" method="POST"><input name="q"></form>
<form action="/search" method="GET"><input name="q"></form>
</body></html>`;

describe("parseForms", () => {
  it("finds state-changing same-origin-agnostic forms, skips GET", () => {
    const fs = parseForms(PAGE, "https://lab.tld/");
    expect(fs.map((f) => f.action)).toEqual(["https://lab.tld/transfer", "https://lab.tld/profile", "https://evil.example/x"]);
    expect(fs[0].method).toBe("POST");
    expect(fs[0].inputs.map((i) => i.name)).toEqual(["amount"]);
  });
});

describe("formHasToken + sameSitePosture", () => {
  it("detects token fields", () => {
    const fs = parseForms(PAGE, "https://lab.tld/");
    expect(formHasToken(fs[0])).toBe(false);
    expect(formHasToken(fs[1])).toBe(true);
  });
  it("reads SameSite posture", () => {
    expect(sameSitePosture(["sid=1; Path=/; SameSite=Lax"])).toBe("lax-or-strict");
    expect(sameSitePosture(["sid=1; Path=/; SameSite=None; Secure"])).toBe("none");
    expect(sameSitePosture(["sid=1; Path=/"])).toBe("missing");
    expect(sameSitePosture([])).toBe("unknown");
  });
});

describe("renderCsrfPoc", () => {
  it("deterministic auto-submit page without token fields", () => {
    const fs = parseForms(PAGE, "https://lab.tld/");
    const a = renderCsrfPoc("https://lab.tld/", fs[0], "F-1");
    const b = renderCsrfPoc("https://lab.tld/", fs[0], "F-1");
    expect(a).toBe(b);
    expect(a).toContain('action="https://lab.tld/transfer"');
    expect(a).toContain('name="amount"');
    expect(a).not.toContain("csrf_token");
  });
});

describe("csrfProve runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await csrfProve("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await csrfProve("u", { url: "https://example.com/" })).toMatch(/SCOPE/);
  });
  it("proves tokenless acceptance, writes PoC, skips tokened + foreign", async () => {
    const fetchFn = async (url: string) => {
      if (url === "http://127.0.0.1:4010/") return { status: 200, body: PAGE.replaceAll("https://lab.tld", "http://127.0.0.1:4010").replaceAll("https://evil.example/x", "https://evil.example/x"), setCookies: ["sid=1; Path=/"] };
      if (url === "http://127.0.0.1:4010/transfer") return { status: 200, body: '{"ok":true}' };
      return { status: 404, body: "" };
    };
    const out = await csrfProve("verify_csrf", { url: "http://127.0.0.1:4010/", fetchFn });
    expect(out).toContain("TANPA TOKEN diterima");
    expect(out).toMatch(/PoC tersimpan: .*csrf-poc-.*\.html/);
    expect(out).toContain("punya field token");
    expect(out).not.toContain("evil.example/x\" —");
    const fs = await import("node:fs");
    fs.rmSync("apps/web/.data/users/verify_csrf", { recursive: true, force: true });
  });
  it("reports NO-FORMS honestly", async () => {
    const out = await csrfProve("u", { url: "http://127.0.0.1:4010/", fetchFn: async () => ({ status: 200, body: "<html>hi</html>" }) });
    expect(out).toContain("NO-FORMS");
  });
});
