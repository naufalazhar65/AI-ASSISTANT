// Unit tests for smuggleProbe pure helpers (no network).
import { describe, expect, it } from "vitest";
import {
  buildProbe,
  buildVictim,
  classifySmuggle,
  obfuscations,
  parseSmuggleTarget,
} from "./smuggleProbe";

describe("parseSmuggleTarget", () => {
  it("parses http/https with default ports, rejects the rest", () => {
    expect(parseSmuggleTarget("http://127.0.0.1:4010/a?b=1")).toMatchObject({
      host: "127.0.0.1",
      port: 4010,
      tls: false,
      path: "/a?b=1",
    });
    expect(parseSmuggleTarget("https://lab.example/")).toMatchObject({ port: 443, tls: true });
    expect(parseSmuggleTarget("http://lab.example/")).toMatchObject({ port: 80, tls: false });
    expect(parseSmuggleTarget("ftp://x/")).toBeNull();
    expect(parseSmuggleTarget("not a url")).toBeNull();
    expect(parseSmuggleTarget("")).toBeNull();
  });
});

describe("buildProbe", () => {
  it("clte hides a complete canary request after the 0-chunk, CL covers it", () => {
    const b = buildProbe("clte", "h", "/", "mia-smuggle-abc");
    expect(b).toContain("Transfer-Encoding: chunked");
    expect(b).toContain("0\r\n\r\nGET /mia-smuggle-abc HTTP/1.1\r\n");
    const body = b.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    const cl = Number((/Content-Length: (\d+)/.exec(b) || [])[1]);
    expect(cl).toBe(Buffer.byteLength(body, "utf8"));
  });
  it("tecl stops CL at the chunk-size line, hidden request follows", () => {
    const b = buildProbe("tecl", "h", "/", "mia-smuggle-abc");
    expect(b).toContain("Transfer-Encoding: chunked");
    const cl = Number((/Content-Length: (\d+)/.exec(b) || [])[1]);
    const body = b.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    // leftover after CL bytes must start with the hidden request
    expect(body.slice(cl)).toMatch(/^GET \/mia-smuggle-abc HTTP\/1\.1/);
    // and the chunk-size line must be a valid hex size of the hidden request
    const hexLine = body.split("\r\n")[0];
    const hidden = `GET /mia-smuggle-abc HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`;
    expect(parseInt(hexLine, 16)).toBe(Buffer.byteLength(hidden, "utf8"));
  });
  it("teob uses an obfuscated TE spelling but the same smuggled shape", () => {
    const b = buildProbe("teob", "h", "/", "mia-smuggle-abc", 0);
    expect(b).toContain(obfuscations()[0]);
    expect(b).not.toMatch(/^Transfer-Encoding: chunked\r$/m);
    expect(b).toContain("0\r\n\r\nGET /mia-smuggle-abc HTTP/1.1\r\n");
  });
  it("obfuscations are distinct non-empty header lines", () => {
    const o = obfuscations();
    expect(o.length).toBeGreaterThanOrEqual(2);
    expect(new Set(o).size).toBe(o.length);
    for (const line of o) expect(line).toMatch(/^Transfer-Encoding:/);
  });
});

describe("buildVictim", () => {
  it("is a plain close-terminated GET for a different path", () => {
    const v = buildVictim("h", "mia-victim-xyz");
    expect(v).toBe("GET /mia-victim-xyz HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
  });
});

describe("classifySmuggle", () => {
  const canary = "mia-smuggle-abc";
  it("CONFIRMED when the canary is answered within <=2 responses", () => {
    const out =
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok" +
      "HTTP/1.1 404 Not Found\r\nContent-Length: 30\r\n\r\nCannot GET /mia-smuggle-abc";
    expect(classifySmuggle(out, canary).verdict).toBe("CONFIRMED");
  });
  it("CONFIRMED when only the canary response arrives", () => {
    const out = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\n/mia-smuggle-abc";
    expect(classifySmuggle(out, canary).verdict).toBe("CONFIRMED");
  });
  it("SIGNAL when canary is answered among 3+ responses (pipelining also does that)", () => {
    const out =
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok" +
      "HTTP/1.1 404 Not Found\r\nContent-Length: 30\r\n\r\nCannot GET /mia-smuggle-abc" +
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    expect(classifySmuggle(out, canary).verdict).toBe("SIGNAL");
  });
  it("REJECTED on strict 400/501 to the ambiguous request", () => {
    expect(
      classifySmuggle("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n", canary).verdict
    ).toBe("REJECTED");
  });
  it("NO-DESYNC on clean normal responses", () => {
    const out =
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found";
    expect(classifySmuggle(out, canary).verdict).toBe("NO-DESYNC");
  });
  it("SIGNAL on total silence (possible backend stall)", () => {
    expect(classifySmuggle("", canary).verdict).toBe("SIGNAL");
  });
});
