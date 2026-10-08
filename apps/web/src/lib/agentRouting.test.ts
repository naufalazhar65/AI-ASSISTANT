import { describe, expect, it } from "vitest";
import {
  DISCORD_MENTION_RE,
  SLACK_MENTION_RE,
  addressedAgentByName,
  addressesThisBot,
  hasForeignMention,
  isNameFragmentOnly,
  mentionedIds,
  routingDropReason,
  ROUTING_NAMES,
  shouldRespondToAgent,
  type AgentLabel,
} from "./agentRouting";

// Unaddressed channel chatter. Every test starts from this so the ONLY variable
// under test is the one the case names.
const CHANNEL = {
  mentioned: false,
  isDM: false,
  inDedicatedChannel: false,
  mentionedOtherTrioBot: false,
} as const;

function solo(label: AgentLabel, extra: Partial<Parameters<typeof shouldRespondToAgent>[1]> = {}) {
  return shouldRespondToAgent(label, { ...CHANNEL, trioMode: false, ...extra });
}
function trio(label: AgentLabel, extra: Partial<Parameters<typeof shouldRespondToAgent>[1]> = {}) {
  return shouldRespondToAgent(label, { ...CHANNEL, trioMode: true, ...extra });
}

describe("shouldRespondToAgent — a typed name addressed to a sibling silences us", () => {
  // These three are the LIVE shapes from Slack on 2026-10-08. Only Mia was
  // configured (no Agnes/Michelle app token yet), so trioMode was false and
  // the solo branch returned true unconditionally: the owner wrote "@Agnes
  // halo" twice and Mia answered both times ("Pagi juga Mas Naufal!",
  // "Halo lagi Mas Naufal!"). Nothing was wrong with Agnes — she had no token.
  // A concierge that replies to "@Agnes" is the exact "everyone answers
  // everything" failure this module exists to prevent.
  it("suppresses solo Mia for the live '@Agnes halo' shape", () => {
    expect(solo("mia", { nameAddressed: "agnes" })).toBe(false);
  });

  it("suppresses solo Mia for a sibling typed name in general", () => {
    expect(solo("mia", { nameAddressed: "michelle" })).toBe(false);
    expect(solo("mia", { nameAddressed: "agnes" })).toBe(false);
  });

  it("outranks the dedicated-channel escape hatch for a sibling's name", () => {
    // Without the guard the solo branch would answer here, because being in a
    // dedicated channel is the one thing that lets a sibling speak up. A name
    // addressed to somebody else has to beat it: the sibling in the room is not
    // the sibling being talked to.
    expect(solo("agnes", { nameAddressed: "michelle", inDedicatedChannel: true })).toBe(false);
    expect(solo("michelle", { nameAddressed: "agnes", inDedicatedChannel: true })).toBe(false);
  });

  it("keeps the trio-mode rule identical", () => {
    expect(trio("mia", { nameAddressed: "agnes" })).toBe(false);
    expect(trio("michelle", { nameAddressed: "agnes" })).toBe(false);
  });

  // Precedence, matching the order the trio branch already used. Both of these
  // were already true before this guard existed in the trio branch; the guard
  // must not silently overrule them in solo mode.
  it("does NOT suppress when this bot is explicitly mentioned", () => {
    expect(solo("mia", { nameAddressed: "agnes", mentioned: true })).toBe(true);
  });

  it("does NOT suppress in a DM (owner may be filing a work item, not summoning)", () => {
    expect(solo("mia", { nameAddressed: "agnes", isDM: true })).toBe(true);
    expect(trio("mia", { nameAddressed: "agnes", isDM: true })).toBe(true);
  });

  it("never suppresses the agent actually addressed, by name or not", () => {
    expect(solo("mia", { nameAddressed: "mia" })).toBe(true);
    expect(trio("mia", { nameAddressed: "mia" })).toBe(true);
  });

  it("leaves unaddressed chatter exactly as it was (no name -> concierge answers)", () => {
    expect(solo("mia", { nameAddressed: null })).toBe(true);
    expect(solo("mia", {})).toBe(true);
    expect(trio("mia", { nameAddressed: null })).toBe(true);
  });

  // The invariant the bug actually violated: solo mode and trio mode must agree
  // about name addressing for the concierge. Before the guard, solo Mia said
  // "yes" where trio Mia said "no" for the identical input.
  it("keeps solo and trio mode in agreement for the concierge, for every name", () => {
    const names: (AgentLabel | null)[] = [null, "mia", "agnes", "michelle"];
    for (const nameAddressed of names) {
      expect({ nameAddressed, answer: solo("mia", { nameAddressed }) }).toEqual({
        nameAddressed,
        answer: trio("mia", { nameAddressed }),
      });
    }
  });
});

describe("addressedAgentByName", () => {
  it("routes exactly one full display name", () => {
    expect(addressedAgentByName("@Agnes halo")).toBe("agnes");
    expect(addressedAgentByName("@Michelle cek")).toBe("michelle");
    expect(addressedAgentByName("@Mia halo")).toBe("mia");
  });

  it("returns null for a group address, a typo, or nothing", () => {
    expect(addressedAgentByName("@Agnes tolong cek sama Michelle")).toBe(null);
    expect(addressedAgentByName("@Mischa halo")).toBe(null);
    expect(addressedAgentByName("halo")).toBe(null);
  });

  it("word-bound: a name glued to more letters is NOT that name", () => {
    // "Michellefib" only matches the mia/agnes patterns, so exactly one name
    // (agnes) is present — the word-bound rule doing its job, not a group
    // address. Locked so a future "loose match" change is visible here.
    expect(addressedAgentByName("@Agnes @Michellefib")).toBe("agnes");
  });

  it("feeds the guard: '@Agnes halo' resolves to agnes, which silences solo Mia", () => {
    const who = addressedAgentByName("@Agnes halo");
    expect(who).toBe("agnes");
    expect(solo("mia", { nameAddressed: who })).toBe(false);
  });
});

describe("isNameFragmentOnly", () => {
  it("classifies autocomplete debris", () => {
    expect(isNameFragmentOnly("ness")).toBe(true);
    expect(isNameFragmentOnly("cell")).toBe(true);
  });

  it("never eats a real message", () => {
    expect(isNameFragmentOnly("hello")).toBe(false);
    expect(isNameFragmentOnly("agnes tolong cek ini")).toBe(false);
    expect(isNameFragmentOnly("cell?")).toBe(false);
    expect(isNameFragmentOnly("")).toBe(false);
  });
});

describe("ROUTING_NAMES", () => {
  it("covers the trio once each (verify.ts locks the Discord display names)", () => {
    expect([...ROUTING_NAMES.map((s) => s.label)].sort()).toEqual(
      ["agnes", "mia", "michelle"].sort(),
    );
  });
});

// Measured live 2026-10-08 14:02 WIB in #all-mia-ltd: the owner TYPED
// "@Agnes halo" and Slack's autocomplete replaced the typed name with real
// mention markup `<@U0C7LPQ3754>`. The Agnes app has no bot token, so that id
// is not in botIds().byLabel. `stripSlackMentions` then deletes the markup —
// and the typed name with it — so `addressedAgentByName("halo")` returned
// null, `mentioned` was false, `mentionedOtherTrioBot` was false, and Mia
// answered "Halo juga Mas Naufal!". These tests pin the RAW text that caused
// it, so the case survives any refactor of the routing guards.
const MIA_BOT_ID = "U0C7H9Z5KRB";
const UNKNOWN_AGNES_ID = "U0C7LPQ3754";
const LIVE_FOREIGN_MENTION = `<@${UNKNOWN_AGNES_ID}> halo`;

describe("mentionedIds / hasForeignMention", () => {
  it("extracts user ids from raw Slack mention markup", () => {
    expect(mentionedIds(LIVE_FOREIGN_MENTION, SLACK_MENTION_RE)).toEqual([UNKNOWN_AGNES_ID]);
    expect(mentionedIds(`<@${MIA_BOT_ID}> halo`, SLACK_MENTION_RE)).toEqual([MIA_BOT_ID]);
    expect(mentionedIds(`<@${MIA_BOT_ID}|mia> halo`, SLACK_MENTION_RE)).toEqual([MIA_BOT_ID]);
  });

  it("de-duplicates repeated mentions of the same person", () => {
    expect(mentionedIds(`<@${MIA_BOT_ID}> x <@${MIA_BOT_ID}> y`, SLACK_MENTION_RE)).toEqual([MIA_BOT_ID]);
  });

  it("flags a mention whose id we cannot resolve", () => {
    expect(hasForeignMention(LIVE_FOREIGN_MENTION, [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(true);
  });

  it("does NOT flag our own bot id or a mapped sibling id", () => {
    expect(hasForeignMention(`<@${MIA_BOT_ID}> halo`, [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(false);
    expect(
      hasForeignMention("<@U0C7LPQ3754> halo", [MIA_BOT_ID, UNKNOWN_AGNES_ID], SLACK_MENTION_RE),
    ).toBe(false);
  });

  it("does NOT flag role/broadcast pings — they are not user mentions", () => {
    // @here / @channel / subteam mentions must never silence the concierge:
    // they address the room, not one person.
    expect(hasForeignMention("@channel halo semua", [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(false);
    expect(hasForeignMention("<!subteam^S0MISHA> halo", [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(false);
  });

  it("does NOT flag Discord role or channel mentions", () => {
    // `<@&roleId>` is a role ping and `<#channelId>` is a channel link — both
    // address the room. Only `<@id>` / `<@!id>` is a user mention.
    expect(hasForeignMention("<@&123456789 everyone look", ["1"], DISCORD_MENTION_RE)).toBe(false);
    expect(hasForeignMention("<#123456789> is that repo", ["1"], DISCORD_MENTION_RE)).toBe(false);
    expect(hasForeignMention("<@!998877> halo", ["1"], DISCORD_MENTION_RE)).toBe(true);
  });

  it("never fires on plain text (pre-2026-10-08 behavior is unchanged)", () => {
    expect(hasForeignMention("halo semua", [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(false);
    expect(hasForeignMention("", [MIA_BOT_ID], SLACK_MENTION_RE)).toBe(false);
  });
});

describe("shouldRespondToAgent — an unresolvable mention silences us", () => {
  // The typed-name guard cannot see this case: after mention-stripping there
  // is no name left, so `nameAddressed` is null and the router looks like it is
  // handling unaddressed concierge chatter.
  it("suppresses solo Mia for the live unresolved-mention shape", () => {
    expect(solo("mia", { nameAddressed: addressedAgentByName("halo"), mentionedForeignUser: true })).toBe(
      false,
    );
  });

  it("suppresses trio Mia too, not just solo", () => {
    expect(trio("mia", { mentionedForeignUser: true })).toBe(false);
    expect(trio("michelle", { mentionedForeignUser: true })).toBe(false);
  });

  it("does not suppress the sibling the message actually mentions", () => {
    // Agnes has no token so nothing is delivered, but if she ever is
    // configured she must be the one allowed to answer.
    expect(trio("agnes", { mentionedForeignUser: true, mentioned: true })).toBe(true);
  });

  it("keeps answering when WE are mentioned in the same message", () => {
    // Markup naming this bot is deliberate, even alongside other mentions:
    // "<@Agnes> FYI <@Mia> tolong cek" must reach Mia.
    expect(solo("mia", { mentionedForeignUser: true, mentioned: true })).toBe(true);
    expect(trio("mia", { mentionedForeignUser: true, mentioned: true })).toBe(true);
  });

  it("keeps answering in a DM and in our own dedicated channel", () => {
    expect(solo("mia", { mentionedForeignUser: true, isDM: true })).toBe(true);
    expect(solo("michelle", { mentionedForeignUser: true, inDedicatedChannel: true })).toBe(true);
  });

  it("keeps answering when our name is still typed after the mention", () => {
    // The unresolvable id is weaker evidence than a typed name naming us.
    expect(solo("mia", { mentionedForeignUser: true, nameAddressed: "mia" })).toBe(true);
  });

  it("stays silent when the foreign mention and a sibling name disagree", () => {
    // "<@U0C7LPQ3754> halo michelle" — the typed name still says Michelle.
    expect(solo("mia", { mentionedForeignUser: true, nameAddressed: "michelle" })).toBe(false);
  });

  it("leaves ordinary concierge chatter alone when the flag is absent", () => {
    expect(solo("mia", {})).toBe(true);
    expect(trio("mia", {})).toBe(true);
    expect(trio("michelle", {})).toBe(false);
  });
});

describe("addressesThisBot (live 2026-10-08 bot-to-bot routing regression)", () => {
  const MIA = "U0C7H9Z5KRB";
  const AGNES = "U0C7LPQ3754";
  const MICHELLE = "U0C7LTQMGLE";

  it("a sibling bot's message that names nobody does NOT address me", () => {
    // The live shape: Mia posted an unaddressed line, Agnes replied to it.
    const raw = "Eh, ada apa nih Mas Naufal?";
    expect(addressesThisBot(raw, MIA, true, MIA)).toBe(false);
    expect(addressesThisBot(raw, AGNES, true, MIA)).toBe(false);
  });

  it("a bot message that DOES name me addresses only me", () => {
    const raw = `<@${AGNES}> halo, cek dong`;
    expect(addressesThisBot(raw, AGNES, true, MIA)).toBe(true);
    // `event.bot_id` is Mia's on every message Mia writes, so it must not leak
    // into "was I mentioned" for the siblings.
    expect(addressesThisBot(raw, MIA, true, MIA)).toBe(false);
    expect(addressesThisBot(raw, MICHELLE, true, MIA)).toBe(false);
  });

  it("never trusts event.bot_id as proof of being named (the bug itself)", () => {
    // Every bot id, as the author, on an empty message -> nobody is mentioned.
    for (const author of [MIA, AGNES, MICHELLE]) {
      expect(addressesThisBot("halo semua", MIA, true, author)).toBe(false);
      expect(addressesThisBot("halo semua", AGNES, true, author)).toBe(false);
      expect(addressesThisBot("halo semua", MICHELLE, true, author)).toBe(false);
    }
  });

  it("keeps the human app_mention path working", () => {
    // A human author: Slack sets bot_id on app_mention events, and the raw text
    // may or may not carry markup (e.g. an alias-style mention).
    expect(addressesThisBot("halo", MIA, false, MIA)).toBe(true);
    expect(addressesThisBot(`<@${MIA}> halo`, AGNES, false, undefined)).toBe(false);
    expect(addressesThisBot(`<@${MIA}> halo`, MIA, false, undefined)).toBe(true);
  });

  it("is safe when this bot has no id yet", () => {
    expect(addressesThisBot(`<@${AGNES}> halo`, undefined, false, undefined)).toBe(false);
    expect(addressesThisBot(`<@${AGNES}> halo`, undefined, true, AGNES)).toBe(false);
  });

  it("routing now follows the name for bot-to-bot, not a race", () => {
    const raw = `<@${AGNES}> halo, cek dong`;
    const opts = (label: AgentLabel) => ({
      mentioned: addressesThisBot(raw, idFor(label), true, MIA),
      isDM: false,
      inDedicatedChannel: false,
      mentionedOtherTrioBot: true,
      trioMode: true,
      nameAddressed: null,
    });
    function idFor(l: AgentLabel) {
      return l === "mia" ? MIA : l === "agnes" ? AGNES : MICHELLE;
    }
    expect(shouldRespondToAgent("agnes", opts("agnes"))).toBe(true);
    expect(shouldRespondToAgent("mia", opts("mia"))).toBe(false);
    expect(shouldRespondToAgent("michelle", opts("michelle"))).toBe(false);
  });
});

describe("routingDropReason (every suppression is nameable, live 2026-10-08)", () => {
  const base = {
    mentioned: false,
    isDM: false,
    inDedicatedChannel: false,
    mentionedOtherTrioBot: false,
    trioMode: true,
    nameAddressed: null,
  } satisfies Parameters<typeof routingDropReason>[1];
  const opt = (o: Partial<Parameters<typeof routingDropReason>[1]>) => ({ ...base, ...o });

  it("is null exactly when routing lets the bot answer", () => {
    // Same verdict source as shouldRespondToAgent, so the two cannot disagree.
    for (const l of ["mia", "agnes", "michelle"] as const) {
      for (const o of [
        opt({}), // mia concierge
        opt({ nameAddressed: "agnes" as const }), // agnes
        opt({ mentioned: true, mentionedOtherTrioBot: true }), // whoever is named
      ]) {
        const reason = routingDropReason(l, o);
        if (shouldRespondToAgent(l, o)) expect(reason).toBeNull();
        else expect(typeof reason).toBe("string");
      }
    }
  });

  it("names the sibling case that a hop-limit drop used to disguise", () => {
    const reason = routingDropReason("mia", opt({ mentionedOtherTrioBot: true }));
    expect(reason).toBe("addressed a sibling bot");
  });

  it("names every other suppression branch", () => {
    expect(routingDropReason("mia", opt({ nameAddressed: "agnes" }))).toBe("typed name -> agnes");
    expect(routingDropReason("mia", opt({ mentionedForeignUser: true }))).toContain("unresolvable mention");
    expect(routingDropReason("agnes", opt({ trioMode: false }))).toBe("not mentioned (solo mode)");
    expect(routingDropReason("michelle", opt({}))).toContain("unaddressed channel chatter");
  });
});
