// Unit tests for massAssign pure helpers + runner (no network).
import { describe, expect, it } from "vitest";
import { bodyWithFields, massAssign, massPayloads, massVerdict } from "./massAssign";

describe("massPayloads + bodyWithFields", () => {
  it("covers privileged fields, bounded", () => {
    const ps = massPayloads();
    expect(ps.length).toBeLessThanOrEqual(8);
    expect(ps.map((p) => p.field)).toContain("role");
  });
  it("merges into JSON or falls back to form", () => {
    const j = bodyWithFields('{"name":"x"}', { role: "admin" });
    expect(j.contentType).toBe("application/json");
    expect(JSON.parse(j.body)).toMatchObject({ name: "x", role: "admin" });
    const f = bodyWithFields("not-json", { role: "admin" });
    expect(f.contentType).toContain("urlencoded");
    expect(f.body).toContain("role=admin");
  });
});

describe("massVerdict", () => {
  const base = { status: 200, digest: "aa", body: '{"name":"x"}' };
  it("flags echo only when new in test", () => {
    expect(massVerdict(base, { status: 200, digest: "bb", body: '{"role":"admin"}' }, "role", "admin").verdict).toBe("ECHO");
    expect(massVerdict({ ...base, body: '{"role":"admin"}' }, { status: 200, digest: "bb", body: '{"role":"admin"}' }, "role", "admin").verdict).not.toBe("ECHO");
  });
  it("rejects on 401/403/400, no-diff on identical", () => {
    expect(massVerdict(base, { status: 403, digest: "z", body: "" }, "role", "admin").verdict).toBe("REJECTED");
    expect(massVerdict(base, { status: 200, digest: "aa", body: '{"name":"x"}' }, "role", "admin").verdict).toBe("NO-DIFF");
  });
  it("accepted-diff on silent outcome change", () => {
    expect(massVerdict(base, { status: 200, digest: "zz", body: '{"ok":1}' }, "role", "admin").verdict).toBe("ACCEPTED-DIFF");
  });
});

describe("massAssign runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await massAssign("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await massAssign("u", { url: "https://example.com/", body: "{}" })).toMatch(/SCOPE/);
  });
  it("finds echo + persisted elevation via injected fetch", async () => {
    let elevated = false;
    const fetchFn = async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/me")) return { status: 200, body: elevated ? '{"role":"admin"}' : '{"role":"user"}' };
      const b = init?.body || "";
      if (b.includes('"role":"admin"') || b.includes("role=admin")) { elevated = true; return { status: 200, body: '{"saved":true,"role":"admin"}' }; }
      return { status: 200, body: '{"saved":true}' };
    };
    const out = await massAssign("u", {
      url: "http://127.0.0.1:4010/profile", body: '{"name":"x"}',
      verify_url: "http://127.0.0.1:4010/me", fetchFn,
    });
    expect(out).toContain("ter-reflect");
    expect(out).toContain("TERKONFIRMASI PERSISTEN");
  });
  it("honest negative when ignored", async () => {
    const out = await massAssign("u", {
      url: "http://127.0.0.1:4010/profile", body: "{}",
      fetchFn: async () => ({ status: 200, body: '{"ok":true}' }),
    });
    expect(out).toContain("Tidak ada kandidat");
  });
});
