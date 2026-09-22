// Unit tests for idorEnum (no network — injected fetch + temp session store).
import { describe, expect, it } from "vitest";
import { idorEnum } from "./idorEnum";
import { setSession } from "./httpSession";

const U = "verify_idor_enum_tmp";

function seed() {
  setSession(U, "va", { cookies: { s: "a1" } });
  setSession(U, "vb", { cookies: { s: "b2" } });
}

function cleanup() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  fs.rmSync(`apps/web/.data/users/${U}`, { recursive: true, force: true });
}

// per-ID bodies: identical for both sessions except diffAt; anon gets 403
const mkFetch = (diffAt: number) => async (url: string, init?: { headers?: Record<string, string> }) => {
  const ck = init?.headers?.["cookie"] || "";
  if (!ck) return { status: 403, body: "login" };
  const id = /[?&]id=(\d+)/.exec(url)?.[1] || "1";
  const body = id === String(diffAt) && ck.includes("a1")
    ? `{"doc":${id},"owner":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
    : `{"doc":${id},"owner":"shared-owners-shared-owners-shared-own","pad":"qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"}`;
  return { status: 200, body };
};

describe("idorEnum guards", () => {
  it("rejects non-http, out-of-scope, and missing sessions", async () => {
    expect(await idorEnum(U, { url: "ftp://x" })).toMatch(/^Error:/);
    expect(await idorEnum(U, { url: "https://example.com/d?id=1" })).toMatch(/SCOPE/);
    expect(await idorEnum(U, { url: "http://127.0.0.1:4010/d?id=1" })).toMatch(/2 sesi/);
  });
});

describe("idorEnum counting", () => {
  it("counts hits as n/tested and stops honestly", async () => {
    seed();
    try {
      const out = await idorEnum(U, {
        url: "http://127.0.0.1:4010/d?id=1", session_a: "va", session_b: "vb",
        id_start: 1, id_end: 4, fetchFn: mkFetch(2),
      });
      expect(out).toContain("id=1");
      expect(out).not.toMatch(/id=2 →/);
      expect(out).toMatch(/3\/4 ID dapat diakses/);
    } finally {
      cleanup();
    }
  });
  it("downgrades public ranges via the anon control", async () => {
    seed();
    try {
      const pubFetch = async (url: string) => {
        const id = /[?&]id=(\d+)/.exec(url)?.[1] || "1";
        return { status: 200, body: `{"doc":${id},"pad":"pppppppppppppppppppppppppppppppppppppppppppp"}` };
      };
      const out = await idorEnum(U, {
        url: "http://127.0.0.1:4010/d?id=1", session_a: "va", session_b: "vb",
        id_start: 1, id_end: 3, fetchFn: pubFetch,
      });
      expect(out).toContain("PUBLIK");
    } finally {
      cleanup();
    }
  });
});
