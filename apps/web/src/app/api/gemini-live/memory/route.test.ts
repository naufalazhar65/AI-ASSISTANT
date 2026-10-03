/**
 * Tests for POST /api/gemini-live/memory (Live write-back route).
 *
 * The contract under test: a Live turn is persisted under the header user
 * and NEVER anywhere else — a missing/invalid user is a 400, not a silent
 * write to the shared store. Cases use a throwaway user and clean up after
 * themselves; the file-content case proves the entry really landed on disk.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { userDataRoot } from "@/lib/users";

import { POST } from "./route";

function post(body: unknown, user?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (user !== undefined) headers["x-mia-user"] = user;
  return new NextRequest("http://localhost/api/gemini-live/memory", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/gemini-live/memory", () => {
  const user = `verify_livemem_${Date.now()}`;

  it("400s when the user header is missing (never writes to shared)", async () => {
    const res = await POST(post({ heard: "halo", said: "halo juga" }));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid user key", async () => {
    const res = await POST(post({ heard: "halo", said: "halo juga" }, "../evil"));
    expect(res.status).toBe(400);
  });

  it("400s on a non-JSON body", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/gemini-live/memory", {
        method: "POST",
        headers: { "x-mia-user": user },
        body: "not-json{{{",
      })
    );
    expect(res.status).toBe(400);
  });

  it("answers saved:false without touching disk on an empty turn", async () => {
    const res = await POST(post({ heard: "   ", said: "" }, user));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: false });
  });

  it("persists a real turn and the entry is readable on disk", async () => {
    try {
      const res = await POST(post({ heard: "ingat kucingku Moly", said: "iya, Moly" }, user));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        saved: true,
        verification: { verdict: "clean", note: "", executed: [] },
      });

      const { readDailyMemory } = await import("@/lib/dailyMemory");
      const { wibDay } = await import("@/lib/time");
      const content = readDailyMemory(user, wibDay());
      expect(content).toContain("User: ingat kucingku Moly");
      expect(content).toContain("Mia: iya, Moly");
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  });

  it("caps an overlong turn instead of storing megabytes", async () => {
    try {
      const res = await POST(post({ heard: "u".repeat(5000), said: "m".repeat(5000) }, user));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        saved: true,
        verification: { verdict: "clean", note: "", executed: [] },
      });

      const { readDailyMemory } = await import("@/lib/dailyMemory");
      const { wibDay } = await import("@/lib/time");
      const content = readDailyMemory(user, wibDay());
      expect(content.length).toBeLessThan(5000);
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  });
});
