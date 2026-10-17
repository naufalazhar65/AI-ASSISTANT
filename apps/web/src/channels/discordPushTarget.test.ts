import { describe, expect, it } from "vitest";
import { resolvePushTarget, type BotPushContext } from "./discord";

// Owner decision 2026-10-17: proactive pushes go to the configured
// DISCORD_CHANNEL_ID_* channel (#general), not to the owner's DM.
function ctx(over: Partial<BotPushContext> = {}): BotPushContext {
  return {
    lastSeen: null,
    dedicatedChannels: [],
    officeChannels: [],
    officeTarget: null,
    client: null,
    allowedUsers: [],
    ...over,
  };
}

const channel = { id: "general", send: async () => undefined };
const dm = { id: "dm", send: async () => undefined };
const client = {
  channels: { fetch: async (id: string) => (id === "general" ? channel : null) },
  users: { fetch: async () => ({ createDM: async () => dm }) },
} as never;

describe("resolvePushTarget prefers the configured #general channel", () => {
  it("wins over last-seen (the DM regression)", async () => {
    expect(await resolvePushTarget(ctx({ officeChannels: ["general"], lastSeen: dm as never, client }))).toBe(channel);
  });

  it("falls back to last-seen when no channel is configured", async () => {
    expect(await resolvePushTarget(ctx({ lastSeen: dm as never }))).toBe(dm as never);
  });

  it("falls back to the owner DM when nothing else is known", async () => {
    expect(await resolvePushTarget(ctx({ client, allowedUsers: ["owner"] }))).toBe(dm as never);
  });

  it("returns null when there is nowhere to send", async () => {
    expect(await resolvePushTarget(ctx())).toBeNull();
  });
});