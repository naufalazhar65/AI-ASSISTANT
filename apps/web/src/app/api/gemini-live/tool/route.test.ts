/**
 * Tests for POST /api/gemini-live/tool (Phase B execution route).
 *
 * The contract under test: the browser's Live session may only execute the
 * allowlisted voice tools, as the right user, with bounded results — and a
 * tampered client naming any other tool gets an honest error string, never
 * an execution. Cases that need no credentials (all Spotify reads answer
 * `not_connected` without one) prove the dispatch path without network.
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";

function post(body: unknown, user?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (user) headers["x-mia-user"] = user;
  return new NextRequest("http://localhost/api/gemini-live/tool", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<{ results?: Array<{ id: string; name: string; result: string }> } & Record<string, unknown>> {
  return (await res.json()) as { results?: Array<{ id: string; name: string; result: string }> };
}

describe("POST /api/gemini-live/tool", () => {
  it("400s on a missing calls array", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
  });

  it("executes an allowlisted read and answers honestly without credentials", async () => {
    const res = await POST(post({ calls: [{ id: "c1", name: "spotify_status", args: {} }] }, "naufalazhar652952"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.results).toHaveLength(1);
    expect(body.results?.[0]?.id).toBe("c1");
    expect(body.results?.[0]?.name).toBe("spotify_status");
    // No linked Spotify account in test env: the tool must say so, not crash.
    expect(typeof body.results?.[0]?.result).toBe("string");
    expect((body.results?.[0]?.result ?? "").length).toBeGreaterThan(0);
  });

  it("refuses a non-allowlisted tool by name instead of executing it", async () => {
    const res = await POST(
      post({ calls: [{ id: "c9", name: "exec", args: { cmd: "ls" } }] }, "naufalazhar652952")
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.results?.[0]?.result).toMatch(/not available in voice mode/);
  });

  it("generates a stable id when the model omits one", async () => {
    const res = await POST(post({ calls: [{ name: "spotify_devices", args: {} }] }, "naufalazhar652952"));
    const body = await json(res);
    expect(body.results?.[0]?.id).toBe("live-0");
  });

  it("bounds results so a dump cannot stall the synchronous call", async () => {
    const res = await POST(post({ calls: [{ id: "c2", name: "spotify_search", args: { query: "x" } }] }, "naufalazhar652952"));
    const body = await json(res);
    expect((body.results?.[0]?.result ?? "").length).toBeLessThanOrEqual(2_000);
  });

  it("dispatches memory reads for a user with no store instead of throwing", async () => {
    const user = `verify_livetool_${Date.now()}`;
    const res = await POST(
      post({ calls: [{ id: "m1", name: "memory_get", args: { date: "today" } }] }, user)
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.results?.[0]?.result).toBe("string");
  });

  it("dispatches memory search without network", async () => {
    const user = `verify_livetool_${Date.now()}`;
    const res = await POST(
      post({ calls: [{ id: "m2", name: "search_memory", args: { query: "cat" } }] }, user)
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.results?.[0]?.result).toBe("string");
  });
});
