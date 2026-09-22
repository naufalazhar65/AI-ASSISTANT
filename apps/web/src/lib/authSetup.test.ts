// Unit tests for authSetup pure helpers (no network).
import { describe, expect, it } from "vitest";
import { cleanSessionName } from "./authSetup";
import { authSetup } from "./authSetup";

describe("cleanSessionName", () => {
  it("lowercases + strips unsafe chars, falls back", () => {
    expect(cleanSessionName("Admin A", "x")).toBe("admina");
    expect(cleanSessionName("../../etc", "x")).toBe("etc");
    expect(cleanSessionName("", "fallback")).toBe("fallback");
    expect(cleanSessionName("a".repeat(50), "x")).toHaveLength(32);
  });
});

describe("authSetup guards (no network)", () => {
  it("refuses missing/non-http/out-of-scope login_url", async () => {
    expect(await authSetup("u", {})).toMatch(/^Error: login_url wajib/);
    expect(await authSetup("u", { login_url: "ftp://x" })).toMatch(/^Error: login_url harus/);
    expect(await authSetup("u", { login_url: "https://example.com/login", accounts: [] })).toMatch(/^Error: SCOPE/);
  });
  it("refuses empty accounts and caps at 4", async () => {
    const r = await authSetup("u", { login_url: "http://127.0.0.1:4010/login", accounts: [] });
    expect(r).toMatch(/accounts wajib/);
  });
  it("rejects malformed credential shape without network", async () => {
    const r = await authSetup("u", {
      login_url: "http://127.0.0.1:4010/login",
      accounts: [{ credential: "nouserpass", session: "a" }],
    });
    expect(r).toContain("user:pass");
  });
});
