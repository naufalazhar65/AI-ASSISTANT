/**
 * Behavioural tests for the Slack adapter's authorisation gate.
 *
 * Why this file exists (measured 2026-10-08): `isAllowedAuthor` shipped with a
 * fail-open branch that required "nothing at all is configured"
 * (`ALLOWED_USER_IDS.length === 0 && configured.size === 0`). `configured` is the
 * bot-id map filled by `auth.test()`, which runs BEFORE the first inbound event,
 * so the branch was dead the moment the bot connected: a solo Mia started with
 * only `SLACK_USER` dropped every owner message and logged nothing. A source
 * read cannot catch that class of bug — the condition looks defensive and is in
 * fact unreachable — so the gate is exercised as a function, twice, in both
 * directions.
 *
 * The module reads `SLACK_ALLOWED_USER_ID` once at import time (module-level
 * const, same as the adapter), so each case reloads the module with a fresh env.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type SlackModule = typeof import("./slack");

const BOT_ID = "U0BOTMIA";
const SIBLING_BOT_ID = "U0SIBLING";
const OWNER_ID = "U0OWNER";
const STRANGER_ID = "U0STRANGER";

/** Load the adapter with a controlled env + a controlled bot-id map. */
async function loadWith(
  allowedUserIds: string | undefined,
  byLabel: Record<string, string> = {},
): Promise<SlackModule> {
  vi.resetModules();
  if (allowedUserIds === undefined) delete process.env.SLACK_ALLOWED_USER_ID;
  else process.env.SLACK_ALLOWED_USER_ID = allowedUserIds;
  (globalThis as unknown as { __slackBotIds?: unknown }).__slackBotIds = {
    byLabel,
    displayNames: {},
  };
  return import("./slack");
}

afterEach(() => {
  delete process.env.SLACK_ALLOWED_USER_ID;
  delete (globalThis as unknown as { __slackBotIds?: unknown }).__slackBotIds;
  vi.resetModules();
});

describe("isAllowedAuthor", () => {
  it("allows the owner id and every configured sibling bot, rejects strangers", async () => {
    const slack = await loadWith(OWNER_ID, { mia: BOT_ID, michelle: SIBLING_BOT_ID });
    expect(slack.isAllowedAuthor(OWNER_ID, false)).toBe(true);
    expect(slack.isAllowedAuthor(BOT_ID, true)).toBe(true);
    expect(slack.isAllowedAuthor(SIBLING_BOT_ID, true)).toBe(true);
    expect(slack.isAllowedAuthor(STRANGER_ID, false)).toBe(false);
  });

  it("REGRESSION: with no allow-list, the owner is still allowed AFTER the bot connected", async () => {
    // This is the live bug: `byLabel` is already populated here, exactly as it is
    // when a real event arrives. The old condition demanded an EMPTY bot map and
    // therefore refused the owner forever.
    const slack = await loadWith(undefined, { mia: BOT_ID });
    expect(slack.slackAuthorLabel(BOT_ID)).toBe("mia");
    expect(slack.isAllowedAuthor(OWNER_ID, false)).toBe(true);
  });

  it("with no allow-list, still refuses a workspace bot that is not part of the trio", async () => {
    // Fail-open is scoped to the owner human, never to arbitrary bots.
    const slack = await loadWith(undefined, { mia: BOT_ID });
    expect(slack.isAllowedAuthor("U0RANDOMBOT", true)).toBe(false);
    expect(slack.isAllowedAuthor("U0RANDOMBOT", false)).toBe(true);
  });

  it("with no allow-list and no bot connected yet, the owner is allowed", async () => {
    const slack = await loadWith(undefined, {});
    expect(slack.isAllowedAuthor(OWNER_ID, false)).toBe(true);
  });
});

describe("slackDedupeNamespace", () => {
  // Slack fans every channel message out to EVERY app in that channel, so all
  // three bots get the same `channel:ts`. A shared namespace meant the first bot
  // to arrive claimed the id and the other two dropped the message as a
  // "duplicate" — live 2026-10-08: one owner message produced three
  // `duplicate event ignored` lines and no turn at all.
  const EVENT = "C0C7MV7RBHQ:1791446049.264259";

  it("gives every trio member a DISTINCT namespace", async () => {
    const slack = await loadWith(OWNER_ID, { mia: BOT_ID, agnes: SIBLING_BOT_ID });
    const ns = (["mia", "agnes", "michelle"] as const).map((l) => slack.slackDedupeNamespace(l));
    expect(new Set(ns).size).toBe(3);
  });

  it("FEEDS alreadyProcessed so one bot's arrival never silences a sibling", async () => {
    // Behavioural, not structural: this is the exact call shape used onMessage().
    const slack = await loadWith(OWNER_ID, { mia: BOT_ID, agnes: SIBLING_BOT_ID });
    const { alreadyProcessed, __resetOnceForTests } = await import("../lib/once");
    __resetOnceForTests();

    expect(alreadyProcessed(slack.slackDedupeNamespace("mia"), EVENT)).toBe(false); // mia claims it
    expect(alreadyProcessed(slack.slackDedupeNamespace("agnes"), EVENT)).toBe(false); // agnes must NOT be silenced
    expect(alreadyProcessed(slack.slackDedupeNamespace("michelle"), EVENT)).toBe(false);
    // ...and the protection we actually want is intact: a REAL socket redelivery
    // to the same bot is still caught.
    expect(alreadyProcessed(slack.slackDedupeNamespace("mia"), EVENT)).toBe(true);

    __resetOnceForTests();
  });
});

describe("slackAuthorLabel / isSelfAuthored — BOTH id kinds (live 2026-10-08)", () => {
  // auth.test gives user_id U… and bot_id B…. A bot-authored message carries
  // bot_id and NO user, so a lookup comparing only user_id silently answered
  // null for every sibling message — the peer was never identified and the
  // owner kept getting greeted in agent-to-agent chats.
  const MIA = { user_id: "U0C7H9Z5KRB", bot_id: "B0C777NUU0P" };
  const AGNES = { user_id: "U0C7LPQ3754", bot_id: "B0C8H49CHLG" };
  const MICHELLE = { user_id: "U0C7LTQMGLE", bot_id: "B0C7QQYMR6V" };

  async function load() {
    const g = globalThis as unknown as { __slackBotIds?: unknown };
    g.__slackBotIds = {
      byLabel: {
        mia: MIA.user_id, "mia:bot": MIA.bot_id,
        agnes: AGNES.user_id, "agnes:bot": AGNES.bot_id,
        michelle: MICHELLE.user_id, "michelle:bot": MICHELLE.bot_id,
      },
      displayNames: {},
    };
    vi.resetModules();
    return await import("./slack");
  }

  it("resolves the user id AND the bot id of every sibling to its label", async () => {
    const slack = await load();
    expect(slack.slackAuthorLabel(MIA.user_id)).toBe("mia");
    expect(slack.slackAuthorLabel(MIA.bot_id)).toBe("mia");
    expect(slack.slackAuthorLabel(AGNES.user_id)).toBe("agnes");
    expect(slack.slackAuthorLabel(AGNES.bot_id)).toBe("agnes");
    expect(slack.slackAuthorLabel(MICHELLE.bot_id)).toBe("michelle");
  });

  it("never returns the ':bot' map key as a label", async () => {
    const slack = await load();
    for (const v of [MIA.bot_id, AGNES.bot_id, MICHELLE.bot_id]) {
      expect(slack.slackAuthorLabel(v)).not.toMatch(/:bot$/);
    }
  });

  it("still answers null for an unknown id (the old control)", async () => {
    const slack = await load();
    expect(slack.slackAuthorLabel("U0RANDOMBOT")).toBeNull();
    expect(slack.slackAuthorLabel("")).toBeNull();
  });

  it("detects a bot's own echo by EITHER id kind, and never a sibling's", async () => {
    const slack = await load();
    expect(slack.isSelfAuthored(MIA.bot_id, "mia")).toBe(true);
    expect(slack.isSelfAuthored(MIA.user_id, "mia")).toBe(true);
    expect(slack.isSelfAuthored(AGNES.bot_id, "mia")).toBe(false);
    expect(slack.isSelfAuthored(undefined, "mia")).toBe(false);
  });
});
