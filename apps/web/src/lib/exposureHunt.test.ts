// Unit tests for exposureHunt helpers — pure logic + ephemeral localhost
// servers only (no external network).
import { describe, expect, it } from "vitest";
import { classifyExposure, defaultProbe, EXPOSURE_PATHS, exposureHunt, MAX_BODY_BYTES, MAX_PATHS, redactEnvValues } from "./exposureHunt";

describe("classifyExposure", () => {
  it("flags .git/HEAD with ref marker", () => {
    const h = classifyExposure("/.git/HEAD", 200, "ref: refs/heads/main\n");
    expect(h?.level).toBe("lead");
  });
  it("flags .git/index on DIRC magic", () => {
    expect(classifyExposure("/.git/index", 200, "DIRC\u0000\u0000\u0000\u0002")).not.toBeNull();
  });
  it("silent on 404 and on 200 without marker", () => {
    expect(classifyExposure("/.env", 404, "")).toBeNull();
    expect(classifyExposure("/.env", 200, "<html>login page</html>")).toBeNull();
  });
  it("401/403 is info, never a lead", () => {
    const h = classifyExposure("/.env", 403, "");
    expect(h?.level).toBe("info");
  });
  it("flags htpasswd hash lines (apr1 / sha256crypt / bcrypt)", () => {
    const h = classifyExposure("/.htpasswd", 200, "admin:$apr1$JZ3M8hU8$abcdefghijklmnopqrstuvwxyz12345\nbob:$6$rounds=5000$xyz$0123456789abcdef0123456789abcdef01");
    expect(h?.level).toBe("lead");
    expect(classifyExposure("/.htpasswd", 200, "alice:plaintextpass")).toBeNull();
  });
  it("flags wp-config.php / db.sql markers", () => {
    expect(classifyExposure("/wp-config.php", 200, "define('DB_PASSWORD', 'x')")).not.toBeNull();
    expect(classifyExposure("/db.sql", 200, "CREATE TABLE users (id INT);")).not.toBeNull();
  });
  it("ignores unknown paths", () => {
    expect(classifyExposure("/nope", 200, "x")).toBeNull();
  });
  it("flags /actuator/env as a LEAD on propertySources marker", () => {
    const h = classifyExposure("/actuator/env", 200, '{"activeProfiles":[],"propertySources":[{"name":"x"}]}');
    expect(h?.level).toBe("lead");
    expect(h?.note).toContain("CRITICAL");
  });
  it("flags /actuator/heapdump as a LEAD on hprof/gzip magic", () => {
    expect(classifyExposure("/actuator/heapdump", 200, "JAVA PROFILE 1.0.2")).not.toBeNull();
    expect(classifyExposure("/actuator/heapdump", 200, "\u001f\u008b\u0008\u0000")).not.toBeNull();
  });
  it("dir-listing is info, SPA catch-all is silent", () => {
    const h = classifyExposure("/uploads/", 200, "<title>Index of /uploads</title>");
    expect(h?.level).toBe("info");
    expect(classifyExposure("/uploads/", 200, "<html>My SPA</html>")).toBeNull();
  });
  it("actuator endpoints with SPA catch-all bodies are silent (marker required)", () => {
    expect(classifyExposure("/actuator/mappings", 200, "<html>index.html</html>")).toBeNull();
  });
  it("jolokia exposure is info, never a lead", () => {
    const h = classifyExposure("/jolokia", 200, '{"request":{"type":"version"},"value":{"agent":"1.2"}}');
    expect(h?.level).toBe("info");
  });
});

describe("redactEnvValues", () => {
  it("masks values, keeps keys", () => {
    const out = redactEnvValues("DB_PASS=s3cr3t\nPORT=3000\n# comment");
    expect(out).toContain("DB_PASS=[redacted]");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain("# comment");
  });
  it("masks export KEY=val and dotted .properties keys", () => {
    const out = redactEnvValues("export DB_PASSWORD=topsecret\nspring.datasource.password=root\nlog.level=DEBUG\n");
    expect(out).not.toContain("topsecret");
    expect(out).not.toContain("=root");
    expect(out).toContain("export DB_PASSWORD=[redacted]");
    expect(out).toContain("spring.datasource.password=[redacted]");
    expect(out).toContain("log.level=[redacted]");
  });
  it("masks JSON value fields (Spring /actuator/env shape)", () => {
    const out = redactEnvValues('{"propertySources":[{"properties":{"spring.datasource.password":{"value":"supersecret"}}}]}');
    expect(out).not.toContain("supersecret");
    expect(out).toContain("[redacted]");
    expect(out).toContain("spring.datasource.password");
  });
  it("masks other JSON secret keys", () => {
    const out = redactEnvValues('{"api_key":"AKIA123456","client_secret":"cs000","token":"tok111"}');
    expect(out).not.toContain("AKIA123456");
    expect(out).not.toContain("cs000");
    expect(out).not.toContain("tok111");
    expect(out).toContain("[redacted]");
  });
  it("masks PHP define() constants (wp-config.php.bak)", () => {
    const out = redactEnvValues("define('DB_PASSWORD', 'myp@ss');\ndefine('AUTH_KEY', 'k1');");
    expect(out).not.toContain("myp@ss");
    expect(out).not.toContain("'k1'");
    expect(out).toContain("DB_PASSWORD");
  });
  it("masks nested JSON keys inside .env-style lines", () => {
    const out = redactEnvValues('OAUTH={"refresh_token":"rt9","access_token":"at0"}');
    expect(out).not.toContain("rt9");
    expect(out).not.toContain("at0");
  });
});

describe("defaultProbe", () => {
  const listen = async (handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) => {
    const http = await import("node:http");
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return { server, url: `http://127.0.0.1:${port}/` };
  };
  it("decodes latin1 1:1 so raw gzip magic survives (utf8 would mangle 0x8b)", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x4a, 0x41]));
    });
    try {
      const out = await defaultProbe(url);
      expect(out.status).toBe(200);
      expect(out.body.charCodeAt(0)).toBe(0x1f);
      expect(out.body.charCodeAt(1)).toBe(0x8b);
      expect(out.body).toContain("JA");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("caps body at MAX_BODY_BYTES (streaming byte budget, never buffers whole body)", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(30_000, 0x61));
    });
    try {
      const out = await defaultProbe(url);
      expect(out.status).toBe(200);
      expect(out.body.length).toBe(MAX_BODY_BYTES);
      expect(out.body.length).toBeLessThan(30_000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("returns non-200 status verbatim (redirect:manual, no body follow)", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      res.end();
    });
    try {
      const out = await defaultProbe(url);
      expect(out.status).toBe(302);
      expect(out.body).toBe("");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
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
  it("reports actuator/env lead with redacted JSON preview", async () => {
    const probe = async (url: string) => {
      if (url.endsWith("/actuator/env")) return { status: 200, body: '{"propertySources":[{"properties":{"x.password":{"value":"leakme"}}}]}' };
      return { status: 404, body: "" };
    };
    const out = await exposureHunt("u", { url: "http://127.0.0.1:4010/", probe });
    expect(out).toContain("LEAD");
    expect(out).toContain("/actuator/env");
    expect(out).not.toContain("leakme");
  });
  it("reports clean when nothing matches", async () => {
    const out = await exposureHunt("u", { url: "http://127.0.0.1:4010/", probe: async () => ({ status: 404, body: "" }) });
    expect(out).toContain("Tidak ada resource");
  });
  it("path list matches exported bounds (45 paths, no silent growth)", () => {
    expect(EXPOSURE_PATHS.length).toBe(MAX_PATHS);
    expect(EXPOSURE_PATHS.length).toBe(45);
    expect(new Set(EXPOSURE_PATHS.map((p) => p.path)).size).toBe(EXPOSURE_PATHS.length);
  });
});