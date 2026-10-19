// Live 2026-10-18 (Discord): the owner pinged Michelle's "Engineer" ROLE. No
// member mention, no sibling name inside the role name, so every existing flag
// was false and Mia's concierge branch answered a message meant for Michelle.
// A role ping is addressing someone, exactly like <@bot>, so it must suppress
// the concierge the same way a sibling mention does.
import { describe, expect, it } from "vitest";
import { routingDropReason, shouldRespondToAgent } from "./agentRouting";

const base = {
  mentioned: false,
  isDM: false,
  inDedicatedChannel: false,
  mentionedOtherTrioBot: false,
  trioMode: true,
};

describe("foreign role ping (live 2026-10-18)", () => {
  it("the concierge does not answer a role ping it cannot map", () => {
    expect(shouldRespondToAgent("mia", { ...base, mentionedForeignRole: true })).toBe(false);
  });

  it("every agent stays silent on an unmappable role ping", () => {
    for (const label of ["agnes", "michelle", "mia"] as const) {
      expect(shouldRespondToAgent(label, { ...base, mentionedForeignRole: true })).toBe(false);
    }
  });

  it("an explicit mention of THIS bot still wins over the role ping", () => {
    expect(shouldRespondToAgent("michelle", { ...base, mentioned: true, mentionedForeignRole: true })).toBe(true);
  });

  it("a DM still wins over the role ping", () => {
    expect(shouldRespondToAgent("mia", { ...base, isDM: true, mentionedForeignRole: true })).toBe(true);
  });

  it("no role ping keeps the previous behaviour (concierge answers chatter)", () => {
    expect(shouldRespondToAgent("mia", { ...base })).toBe(true);
  });

  it("the drop is observable, never a silent loss", () => {
    expect(routingDropReason("mia", { ...base, mentionedForeignRole: true })).toBe("role ping that maps to no agent");
  });
});
