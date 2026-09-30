/**
 * Tests for the Live tool allowlist (`liveTools.ts`).
 *
 * The contract under test: the declarations handed to Gemini are built from
 * the SAME registry `executeTool` dispatches, so the schema the model sees
 * can never drift from what the server actually runs — and the custom `risk`
 * marker is never sent (strict APIs reject unknown fields).
 */

import { describe, expect, it } from "vitest";

import {
  LIVE_TOOL_NAMES,
  buildMemoryRecap,
  isLiveToolName,
  liveToolDeclarations,
  loadRecentMemory,
} from "./liveTools";

describe("liveToolDeclarations — built from the registry, not hand-kept", () => {
  it("declares exactly the allowlisted Spotify subset", () => {
    expect([...LIVE_TOOL_NAMES]).toEqual([
      "spotify_status",
      "spotify_search",
      "spotify_play",
      "spotify_pause",
      "spotify_next",
      "spotify_previous",
      "spotify_volume",
      "spotify_devices",
      "search_memory",
      "memory_get",
    ]);
    const decls = liveToolDeclarations();
    expect(decls.map((d) => d.name)).toEqual([...LIVE_TOOL_NAMES]);
  });

  it("carries name, description and a parameters schema per tool", () => {
    for (const d of liveToolDeclarations()) {
      expect(typeof d.name).toBe("string");
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.parameters?.type).toBe("object");
      expect(d.parameters && typeof d.parameters.properties).toBe("object");
    }
    // spotify_play accepts an optional query — the voice's main verb.
    const play = liveToolDeclarations().find((d) => d.name === "spotify_play");
    expect(play?.parameters.properties.query).toBeDefined();
  });

  it("never leaks the internal risk marker", () => {
    expect(JSON.stringify(liveToolDeclarations())).not.toContain("risk");
  });
});

describe("isLiveToolName — the execution gate's vocabulary", () => {
  it("accepts every allowlisted name and nothing else", () => {
    for (const name of LIVE_TOOL_NAMES) expect(isLiveToolName(name)).toBe(true);
    expect(isLiveToolName("spotify_like")).toBe(false);
    expect(isLiveToolName("exec")).toBe(false);
    expect(isLiveToolName("")).toBe(false);
    expect(isLiveToolName(undefined)).toBe(false);
    expect(isLiveToolName(42)).toBe(false);
    expect(isLiveToolName(null)).toBe(false);
  });
});

describe("buildMemoryRecap — the tail of recent days, capped", () => {
  const day = (date: string, content: string) => ({ date, content });

  it("returns empty for no days or no budget", () => {
    expect(buildMemoryRecap([])).toBe("");
    expect(buildMemoryRecap([day("2026-09-29", "hello")], 0)).toBe("");
  });

  it("reads oldest-first with date headings", () => {
    const out = buildMemoryRecap([day("2026-09-28", "aaa"), day("2026-09-29", "bbb")]);
    expect(out.indexOf("2026-09-28")).toBeLessThan(out.indexOf("2026-09-29"));
    expect(out).toContain("aaa");
    expect(out).toContain("bbb");
  });

  it("prefers each day's tail and respects the cap", () => {
    const long = `HEAD-${"x".repeat(5000)}-TAIL`;
    const out = buildMemoryRecap([day("2026-09-29", long)], 300);
    expect(out.length).toBeLessThanOrEqual(300 + 120); // cap + one header line
    expect(out).toContain("TAIL");
    expect(out).not.toContain("HEAD");
  });

  it("loadRecentMemory reads nothing for an unknown user instead of throwing", () => {
    expect(loadRecentMemory(`verify_recap_${Date.now()}`)).toEqual([]);
  });
});
