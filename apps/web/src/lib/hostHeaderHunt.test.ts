// Unit tests for hostHeaderHunt pure helpers + runner (no network).
import { describe, expect, it } from "vitest";
import { evilValue, hostHeaderHunt, hostReflect, HOST_HEADERS } from "./hostHeaderHunt";

describe("hostReflect", () => {
  it("flags Location and body reflection, ignores clean", () => {
    expect(hostReflect("X-Forwarded-Host", "evil-hhx.example", 200, { location: "https://evil-hhx.example/a" }, "", "hhx").kind).toBe("REFLECT");
    expect(hostReflect("Host", "evil-hhx.example", 200, {}, "welcome evil-hhx.example", "hhx").kind).toBe("REFLECT");
    expect(hostReflect("Host", "evil-hhx.example", 200, {}, "welcome home", "hhx").kind).toBe("clean");
  });
  it("matrix has 8 headers", () => {
    expect(HOST_HEADERS).toHaveLength(8);
    expect(evilValue("host", "c").startsWith("evil-")).toBe(true);
  });
});

describe("hostHeaderHunt runner", () => {
  it("rejects non-http and out-of-scope", async () => {
    expect(await hostHeaderHunt("u", { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await hostHeaderHunt("u", { url: "https://example.com/" })).toMatch(/SCOPE/);
  });
  it("detects reflection + reset poisoning via injected fetch", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      seen.push(url);
      const xfh = init?.headers?.["X-Forwarded-Host"] || "";
      if (url === "http://127.0.0.1:4010/" && xfh) {
        return { status: 200, body: `<link href="https://${xfh}/a">`, headers: {} };
      }
      if (url === "http://127.0.0.1:4010/reset" && init?.method === "POST") {
        const xfh2 = init?.headers?.["X-Forwarded-Host"] || "";
        return { status: 200, body: `reset link: https://${xfh2}/reset?t=1`, headers: {} };
      }
      return { status: 200, body: "<html>static</html>", headers: {} };
    };
    const out = await hostHeaderHunt("u", {
      url: "http://127.0.0.1:4010/", reset_url: "http://127.0.0.1:4010/reset",
      email: "victim@lab.tld", fetchFn,
    });
    expect(out).toContain("memantulkan canary");
    expect(out).toContain("RESET-LINK-POISONED");
  });
  it("honest negative + skipped reset without email", async () => {
    const out = await hostHeaderHunt("u", {
      url: "http://127.0.0.1:4010/", reset_url: "http://127.0.0.1:4010/reset",
      fetchFn: async () => ({ status: 200, body: "<html>static</html>", headers: {} }),
    });
    expect(out).toContain("Tidak ada pantulan");
    expect(out).toContain("dilewati (butuh email");
  });
});
