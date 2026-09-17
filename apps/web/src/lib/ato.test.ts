// Account-takeover prover: pure pieces (credential parsing, login body,
// verdict) — the network path is covered end-to-end in verify.ts against a
// local login server.

import { describe, expect, it } from "vitest";
import { atoVerdict, buildLoginBody, looksLikeLoginForm, maskPassword, parseCredential } from "./ato";

describe("parseCredential", () => {
  it("reads user:pass (including a password containing colons)", () => {
    expect(parseCredential("admin:K0h0na_Sup3rAdmin!")).toEqual({ username: "admin", password: "K0h0na_Sup3rAdmin!" });
    expect(parseCredential(" admin : p:a:s:s ")).toEqual({ username: "admin", password: "p:a:s:s" });
  });
  it("rejects anything that is not user:pass", () => {
    for (const bad of ["", "nocolon", ":pass", "user:", "   "]) expect(parseCredential(bad)).toBeNull();
  });
});

describe("buildLoginBody", () => {
  it("defaults to a JSON body with username/password", () => {
    expect(JSON.parse(buildLoginBody({ username: "u", password: "p" }))).toEqual({ username: "u", password: "p" });
  });
  it("honours custom field names", () => {
    expect(JSON.parse(buildLoginBody({ username: "u", password: "p", user_field: "email", pass_field: "passwd" }))).toEqual({ email: "u", passwd: "p" });
  });
  it("substitutes {{username}}/{{password}} in a form template", () => {
    expect(buildLoginBody({ username: "a b", password: "x&y", body_template: "user={{username}}&pass={{password}}" })).toBe("user=a b&pass=x&y");
  });
});

describe("atoVerdict", () => {
  it("confirms takeover when the session unlocks a protected page", () => {
    const v = atoVerdict({ loginStatus: 200, sessionGot: true, protectedStatus: 200, protectedLooksProtected: true });
    expect(v.ok).toBe(true);
    expect(v.label).toMatch(/TAKEOVER TERBUKTI/);
  });
  it("reports a rejected credential, a sessionless login, and a locked page honestly", () => {
    expect(atoVerdict({ loginStatus: 401, sessionGot: false, protectedStatus: null, protectedLooksProtected: false }).ok).toBe(false);
    expect(atoVerdict({ loginStatus: 200, sessionGot: false, protectedStatus: null, protectedLooksProtected: false }).label).toMatch(/TANPA SESI/);
    expect(atoVerdict({ loginStatus: 200, sessionGot: true, protectedStatus: 200, protectedLooksProtected: false }).ok).toBe(false);
  });
  it("accepts a redirect as a successful login", () => {
    expect(atoVerdict({ loginStatus: 302, sessionGot: true, protectedStatus: null, protectedLooksProtected: false }).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("never reveals the full password", () => {
    expect(maskPassword("K0h0na_Sup3rAdmin!")).toBe("K0••••••••");
    expect(maskPassword("ab")).toBe("••");
  });
  it("detects a login form so a non-unlocked page is not called proof", () => {
    expect(looksLikeLoginForm('<input type="password" name="p">')).toBe(true);
    expect(looksLikeLoginForm("<h1>Admin</h1>")).toBe(false);
  });
});
