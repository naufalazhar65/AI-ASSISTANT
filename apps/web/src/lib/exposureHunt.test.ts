// Unit tests for exposureHunt pure helpers (no network).
import { describe, expect, it } from "vitest";
import { classifyExposure, EXPOSURE_PATHS, exposureHunt, redactEnvValues } from "./exposureHunt";

describe("classifyExposure", () => {
  it("flags .git/HEAD with ref marker", () => {
    const h = classifyExposure("/.git/HEAD", 200, "ref: refs/heads/main\n");
    expect(h?.level).toBe("lead");
  });
  it("silent on 404 and on 200 without marker", () => {
    expect(classifyExposure("/.env", 404, "")).toBeNull();
    expect(classifyExposure("/.env", 200, "<html>login page</html>")).toBeNull();
  });
  it("401/403 is info, never a lead", () => {
    const h = classifyExposure("/.env", 403, "");
    expect(h?.level).toBe("info");
  });
  it("ignores unknown paths", () => {
    expect(classifyExposure("/nope", 200, "x")).toBeNull();
  });
});

describe("redactEnvValues", () => {
  it("masks values, keeps keys", () => {
    const out = redactEnvValues("DB_PASS=s3cr3t\nPORT=3000\n# comment");
    expect(out).toContain("DB_PASS=[redacted]");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("# comment");
  });
});

describe("exposureHunt runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await exposureHunt("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await exposureHunt("u", { url: "https://example.com/" })).toMatch(/SCOPE/);
  });
  it("finds leads via injected probe, secrets never leak", async () => {
    const probe = async (url: string) => {
      if (url.endsWith("/.env")) return { status: 200, body: "SECRET_KEY=supersecret123\nDEBUG=true\n" };
      if (url.endsWith("/robots.txt")) return { status: 200, body: "User-agent: *\nDisallow: /admin\n" };
      return { status: 404, body: "" };
    };
    const out = await exposureHunt("u", { url: "http://127.0.0.1:4010/", probe });
    expect(out).toContain("LEAD");
    expect(out).toContain("/.env");
    expect(out).not.toContain("supersecret123");
    expect(out).toContain("robots.txt");
  });
  it("reports clean when nothing matches", async () => {
    const out = await exposureHunt("u", { url: "http://127.0.0.1:4010/", probe: async () => ({ status: 404, body: "" }) });
    expect(out).toContain("Tidak ada resource");
  });
  it("bounded path list", () => {
    expect(EXPOSURE_PATHS.length).toBeLessThanOrEqual(24);
  });
});
