import { describe, it, expect } from "vitest";
import { discordRestTokenHeal } from "./discordRestTokenHeal";

/**
 * Unit contract for the part we own: the heal writes the token we were given to
 * the REST manager, and it is safe to call on every gateway reconnect.
 *
 * What is deliberately NOT asserted here: that a heal actually revives sending.
 * That needs a real discord.js Client whose WebSocketManager is stubbed to fail
 * once, which is slow and reaches into discord.js internals rather than our
 * code. It lives in the durable probe `apps/web/probe-discord-rest-heal.mts`,
 * which asserts both directions against the real library:
 *   login clean          -> send goes out (real HTTP answer from Discord)
 *   login 522 + wipe     -> send dies with the production error string
 *   after heal           -> send goes out again
 */

function fakeClient(): { calls: string[]; rest: { setToken: (t: string) => void } } {
  const calls: string[] = [];
  return { calls, rest: { setToken: (t: string) => void calls.push(t) } };
}

describe("discordRestTokenHeal", () => {
  it("writes the supplied token to the REST manager", () => {
    const c = fakeClient();
    discordRestTokenHeal(c, "TOKEN_A", "mia");
    expect(c.calls).toEqual(["TOKEN_A"]);
  });

  it("is idempotent across reconnects: the last write is still the right token", () => {
    const c = fakeClient();
    discordRestTokenHeal(c, "TOKEN_A", "agnes");
    discordRestTokenHeal(c, "TOKEN_A", "agnes");
    discordRestTokenHeal(c, "TOKEN_A", "agnes");
    expect(c.calls).toEqual(["TOKEN_A", "TOKEN_A", "TOKEN_A"]);
    expect(c.calls.at(-1)).toBe("TOKEN_A");
  });

  it("revives the token after a simulated destroy() wipe", () => {
    const c = fakeClient();
    discordRestTokenHeal(c, "TOKEN_A", "michelle"); // ready #1
    c.calls.length = 0; // login() error path calls destroy() -> setToken(null)
    discordRestTokenHeal(c, "TOKEN_A", "michelle"); // ready #2 after reconnect
    expect(c.calls).toEqual(["TOKEN_A"]);
  });

  it("does not throw on an empty token (never invents one, just forwards)", () => {
    const c = fakeClient();
    expect(() => discordRestTokenHeal(c, "", "mia")).not.toThrow();
    expect(c.calls).toEqual([""]);
  });

  it("passes the label through to the logger so the heal is attributable", () => {
    const seen: string[] = [];
    discordRestTokenHeal(fakeClient(), "TOKEN_A", "agnes", (m) => seen.push(m));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("agnes");
  });
});
