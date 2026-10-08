// Pure trio-routing rules, extracted from channels/discord.ts so Slack (and any
// future adapter) can reuse ONE owner of the decision instead of forking it.
//
// Why this module exists: Slack is the second channel where the trio must route
// ("halo michelle" -> only Michelle answers). The Discord copy was inline and
// coupled to `AGENT_SPECS` (which carries env-var names), so a second copy
// would inevitably drift — and a routing drift in a three-bot channel means the
// owner gets three answers to one question, which is exactly the bug this logic
// was written to prevent (measured 2026-10-06, all three bots answering).
//
// `verify.ts` locks the invariant that makes this safe: every display name in
// ROUTING_NAMES must equal the corresponding `AGENT_SPECS` display name in
// channels/discord.ts. If someone renames a bot in the Discord spec and forgets
// this file, verification fails instead of the trio quietly triple-answering.
//
// Pure: no env reads, no Discord objects, no Slack objects. Everything here is
// a function of its arguments.

/** Trio agent label. "mia" is the concierge; behavior for Mia is unchanged. */
export type AgentLabel = "mia" | "agnes" | "michelle";

/**
 * Display names used by name-based addressing. Kept minimal (label + name) so
 * this module has no knowledge of tokens, env vars, or channels.
 *
 * Order matters only for the fragment heuristic below, which is order
 * independent — it is a set membership test.
 */
export const ROUTING_NAMES: { label: AgentLabel; displayName: string }[] = [
  { label: "mia", displayName: "Mia" },
  { label: "agnes", displayName: "Agnes" },
  { label: "michelle", displayName: "Michelle" },
];

/**
 * Which single agent a message addresses BY TYPED NAME.
 *
 * Owner 2026-10-06: "kalau aku sapa 'halo michelle' pasti semuanya akan
 * nyaut". The router only understood real @mentions and role mentions, so a
 * typed name was invisible and all three bots answered.
 *
 * Rules, chosen so a false positive is impossible in ordinary talk:
 *  - case-insensitive and WORD-BOUNDED against the display name, so
 *    "michelle" / "halo michelle" / "hai Michelle!" match while
 *    "michelles" and "agness" do not;
 *  - the message must actually be addressed (an opening greeting or the name
 *    anywhere is enough — a research answer about "Michelle" is rare enough
 *    that routing to her is harmless);
 *  - EXACTLY ONE name may match. Two names is a group address, which returns
 *    null so the normal concierge routing applies (Mia takes it) rather than
 *    guessing which of the two the owner meant.
 *
 * Measured 2026-10-07 23:4x WIB: the owner typed "Mischa" (a typo) and this
 * returned null, so Mia answered instead of Michelle — the word-bound rule
 * working as designed, not a bug. Say the full name, or use a real mention.
 */
export function addressedAgentByName(text: string): AgentLabel | null {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  const hits: AgentLabel[] = [];
  for (const spec of ROUTING_NAMES) {
    const name = spec.displayName.toLowerCase();
    if (!new RegExp(`\\b${name}\\b`).test(t)) continue;
    hits.push(spec.label);
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Is the post-mention-strip text just the leftover of someone typing a bot
 * name, rather than an actual request?
 *
 * Owner report 2026-10-07 10:14 WIB: typing "@Agnes" in Discord produced
 * `<@3995>ness` — Discord's autocomplete chip swallows the matched prefix and
 * leaves the TAIL of the name as plain text. `stripMentions` correctly turns
 * that into `"ness"`, but `"ness"` is still non-empty, so the existing
 * `if (!text && !fileContexts.length) return;` guard did not catch it and the
 * trio woke up to greet nonsense — three separate messages, each one bot
 * cheerfully inventing a greeting for a non-request.
 *
 * So: a mention plus only the tail of a name carries no REQUEST — but it is
 * still a SUMMON. The caller did mean to wake that bot. An earlier version
 * dropped these messages outright and the owner immediately reported "kenapa
 * sekarang mereka tidak merespon ketika saya panggil itu, mis. ness": the
 * fragment is how this trio gets called, so dropping it un-summoned the bot.
 * The helper therefore only CLASSIFIES the text; the caller uses it to strip
 * the debris, not to discard the turn.
 *
 * Deliberately conservative. Anything with a real word in it is a request and
 * must still reach the model untouched: "agnes tolong cek ini" and even a terse
 * "cell?" are left alone, because a 2-3 character fragment is far more likely
 * to be a real (if lazy) message than autocomplete debris.
 */
export function isNameFragmentOnly(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  // Only short, letters-only debris. A longer or punctuated message is a
  // real one: this guard must never eat a sentence, and "hello" (5 chars)
  // has to survive even though it overlaps "michelle".
  if (t.length < 3 || t.length > 4) return false;
  if (!/^[a-z]+$/.test(t)) return false;
  for (const spec of ROUTING_NAMES) {
    const name = spec.displayName.toLowerCase();
    // The live fragments were the tails the autocomplete chip failed to
    // swallow: "ness" (agnes), "cell" (michelle), "mia" (mia).
    //
    // The chip cut each typed name mid-word, so no suffix rule fits them:
    // "ness" is not a suffix of "agnes" (that is "nes"), and "cell" does not
    // contain michelle's last 3 letters ("lle"). What all three DO share with
    // their name is a 3-character run — "nes", "ell", "mia". Both narrower
    // rules were tried against the live cases and both failed; this one
    // matches all three while the length cap keeps "hello" safe.
    const grams = new Set<string>();
    for (let i = 0; i + 3 <= name.length; i += 1) grams.add(name.slice(i, i + 3));
    for (let i = 0; i + 3 <= t.length; i += 1) {
      if (grams.has(t.slice(i, i + 3))) return true;
    }
  }
  return false;
}

/**
 * Slack user/bot mention markup. Group/role mentions are NOT this shape
 * (`@here`, `@channel`, `<!subteam^…>`), so they can never be mistaken for a
 * person we failed to resolve — an `@everyone` broadcast must not silence the
 * concierge.
 */
export const SLACK_MENTION_RE = /<@([UWB][A-Z0-9]*)(?:\|[^>]*)?>/g;

/**
 * Discord user mention markup. Role mentions are `<@&id>` and channel links
 * `<#id>` — deliberately not matched, for the same reason as Slack above: a
 * role ping is a broadcast to the room, not a summons to one specific person.
 */
export const DISCORD_MENTION_RE = /<@!?(\d+)>/g;

/** Every user/bot id mentioned in the RAW text, in order, de-duplicated. */
export function mentionedIds(rawText: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const m of (rawText || "").matchAll(pattern)) {
    const id = m[1];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Is THIS bot addressed by this message?
 *
 * The trap this exists to avoid: Slack sets `event.bot_id` on every message any
 * bot wrote, so `mentioned = !!event.bot_id || text.includes(self)` reports all
 * three trio members as mentioned for each other's messages — routing becomes a
 * coin flip decided by which app's socket delivers first. Measured live
 * 2026-10-08 15:32 WIB in #all-mia-ltd: an unaddressed line from Mia got a reply
 * from Agnes, and when Mia wrote `<@Agnes> halo, cek dong` only the hop-limit
 * guard (an unrelated budget, already spent by the previous exchange) kept Mia
 * and Michelle quiet. One bot winning the race is not routing — had Mia won, she
 * would have answered a message meant for her sibling.
 *
 * For a BOT author the only warrant is literal `<@ID>` markup in the body: bots
 * do not get the human autocomplete shortcut, and Slack hands us the exact text
 * they sent, so there is no hidden mention for us to miss. For a HUMAN author
 * `event.bot_id` is kept, because that is Slack telling us an `app_mention`
 * event fired for this app.
 */
export function addressesThisBot(
  rawText: string,
  selfBotId: string | undefined,
  isBotAuthor: boolean,
  eventBotId: string | undefined,
): boolean {
  const mentionsMe = !!selfBotId && (rawText || "").includes(`<@${selfBotId}>`);
  // A bot author gets no benefit of the doubt from `event.bot_id` — it is set
  // on every message every bot writes, so trusting it would make "mentioned"
  // mean "authored by a bot" and routing would collapse to a coin flip.
  if (isBotAuthor) return mentionsMe;
  // A human author: Slack only sets `bot_id` on `app_mention` events, so it is
  // a genuine signal that THIS app was summoned.
  return !!eventBotId || mentionsMe;
}

/**
 * Does the message mention at least one person/bot we could NOT resolve?
 *
 * Measured 2026-10-08 14:02 WIB, live Slack: the owner typed "@Agnes halo",
 * Slack's autocomplete converted it to `<@U0C7LPQ3754> halo`, and because the
 * Agnes app has no bot token yet that id never enters `botIds().byLabel`. The
 * consequences stacked up: `stripSlackMentions` deletes the markup (so the
 * typed name is GONE — `addressedAgentByName` returns null), `mentioned` is
 * false (it is not our id), `mentionedOtherTrioBot` is false (Agnes is not in
 * the id map), so every name-based guard passed and Mia — the concierge —
 * cheerfully answered a message addressed to her offline sibling.
 *
 * A mention of an id we do not know is the strongest possible evidence that
 * the owner addressed SOMEONE ELSE. Being unsure who is fine; knowing it was
 * not us is what matters, and that does not require an extra Slack scope.
 * (`users.info` would resolve the id to a real name, but that needs the
 * `users:read` scope — deliberately not required, because one conservative
 * rule that needs no new permission beats two paths whose behavior differs.)
 *
 * Role/broadcast mentions never reach here (see the two patterns above), and
 * our own id is passed in `knownIds`, so "am I mentioned" stays possible.
 */
export function hasForeignMention(
  rawText: string,
  knownIds: Iterable<string>,
  pattern: RegExp,
): boolean {
  const known = new Set(knownIds);
  return mentionedIds(rawText, pattern).some((id) => !known.has(id));
}

/** Trio routing (prevents triple replies). Solo Mia keeps legacy reply-all.
 *  In trio mode an explicit mention (member `<@id>` or role `<@&id>`
 *  name-match, resolved by the adapter's mention flags) wins: a message
 *  addressing sibling bot(s) suppresses everyone not mentioned (DMs always
 *  reply). Unaddressed chatter goes to Mia alone (trio concierge — Mia stays
 *  the center of the owner's experience); a sibling joins unaddressed chatter
 *  only inside its OWN dedicated channel. */
export function shouldRespondToAgent(
  label: AgentLabel,
  opts: {
    mentioned: boolean;
    isDM: boolean;
    inDedicatedChannel: boolean;
    mentionedOtherTrioBot: boolean;
    trioMode: boolean;
    /**
     * Agent addressed by TYPED NAME, or null. Optional so every existing call
     * site and test keeps compiling; when it is null the routing is exactly
     * what it was before. An explicit mention still outranks it — markup is a
     * deliberate act, a typed name is not.
     */
    nameAddressed?: AgentLabel | null;
    /**
     * The raw message mentions at least one user/bot id this adapter could
     * NOT resolve (see `hasForeignMention`). Optional: absent means "no such
     * mention", which is exactly the pre-2026-10-08 behavior.
     *
     * It has to be a SEPARATE signal from `nameAddressed` because the two
     * cover opposite failures: a typed name is text we can read but might
     * address a sibling; a foreign mention is markup whose target we cannot
     * name — and after mention-stripping there is no name left to read at
     * all. Live Slack 2026-10-08: owner typed "@Agnes halo", Slack turned it
     * into `<@U0C7LPQ3754> halo`, the typed name vanished, and Mia answered.
     */
    mentionedForeignUser?: boolean;
  }
): boolean {
  // A message addressed BY TYPED NAME to a different agent is not ours — and
  // that has to hold in SOLO mode too, not just trio mode.
  //
  // Measured 2026-10-08, live Slack: only Mia was configured, so `trioMode` was
  // false and the solo branch below returned `true` unconditionally. Owner wrote
  // "@Agnes halo" and Mia answered it ("Halo juga Mas Naufal!"). Nothing was
  // wrong with Agnes — she simply has no token yet — but a concierge that
  // replies to "@Agnes" is exactly the "everyone answers everything" failure
  // this module exists to prevent, so it must be closed here rather than by
  // insisting the owner never mention an offline sibling.
  //
  // `mentioned` and `isDM` still win, exactly as the trio branch below already
  // orders them (both are checked before `nameAddressed` is consulted): an
  // explicit <@bot> mention of THIS bot is markup — a deliberate act — and a DM
  // is a private conversation with THIS bot, where the owner may well be saying
  // "agnes tolong cek ini" as a work item rather than summoning a sibling. Only
  // unaddressed CHANNEL chatter meant for someone else gets suppressed.
  if (
    opts.nameAddressed &&
    opts.nameAddressed !== label &&
    !opts.mentioned &&
    !opts.isDM
  ) {
    return false;
  }

  // A mention we could not resolve proves the owner addressed someone other
  // than us. Measured 2026-10-08, live Slack: the owner typed "@Agnes halo",
  // Slack's autocomplete turned it into `<@U0C7LPQ3754> halo`, the Agnes app
  // has no token yet so that id is unknown, and the typed name disappeared
  // with the markup — so the guard above had nothing left to read and Mia,
  // the concierge, answered a message meant for her offline sibling.
  //
  // Same precedence as the typed-name guard above, for the same reason:
  //   - `mentioned`  — markup that names THIS bot is a deliberate act, even
  //                    when other people are mentioned in the same message
  //                    ("<@Agnes>FYI <@Mia> tolong cek" must reach Mia);
  //   - `isDM`       — a private conversation with THIS bot;
  //   - `nameAddressed === label` — after stripping an unknown mention there
  //                    may still be a typed "mia" in the text, which is
  //                    stronger evidence than the unresolvable id;
  //   - dedicated channel — the owner is in the room that belongs to this
  //                    agent; unresolvable mentions there are chatter, not a
  //                    summons away.
  //
  // Deliberately no Slack `users.info` resolution: that needs a `users:read`
  // scope we do not have, and one conservative rule that needs no new
  // permission is worth more than a second path that behaves differently once
  // the scope is added. Role/broadcast pings (`@here`, `@everyone`) are not
  // user mentions and never set this flag — see `SLACK_MENTION_RE`.
  if (
    opts.mentionedForeignUser &&
    !opts.mentioned &&
    !opts.isDM &&
    !opts.inDedicatedChannel &&
    opts.nameAddressed !== label
  ) {
    return false;
  }
  if (!opts.trioMode) {
    if (label === "mia") return true;
    return opts.mentioned || opts.isDM || opts.inDedicatedChannel;
  }
  if (opts.mentioned) return true;
  if (opts.isDM) return true;
  if (opts.mentionedOtherTrioBot) return false;
  if (opts.nameAddressed) return opts.nameAddressed === label;
  if (label === "mia") return true;
  return opts.inDedicatedChannel;
}

/**
 * Why did routing suppress this bot? For logs ONLY.
 *
 * The verdict always comes from `shouldRespondToAgent` — this never decides
 * anything, so if the ladder below ever names the wrong reason the log is
 * cosmetically wrong and the behavior is still correct. That asymmetry is
 * deliberate: routing suppressions used to be completely silent, which is how a
 * live mis-route survived two rounds of testing ("is Mia answering because of
 * routing, or did the hop-limit guard happen to stop her?"). A silent drop is
 * indistinguishable from a lost message.
 */
export function routingDropReason(
  label: AgentLabel,
  opts: Parameters<typeof shouldRespondToAgent>[1],
): string | null {
  if (shouldRespondToAgent(label, opts)) return null;
  if (opts.nameAddressed && opts.nameAddressed !== label && !opts.mentioned && !opts.isDM) {
    return `typed name -> ${opts.nameAddressed}`;
  }
  if (
    opts.mentionedForeignUser &&
    !opts.mentioned &&
    !opts.isDM &&
    !opts.inDedicatedChannel &&
    opts.nameAddressed !== label
  ) {
    return "unresolvable mention (not us)";
  }
  if (opts.trioMode && !opts.mentioned && !opts.isDM && opts.mentionedOtherTrioBot) {
    return "addressed a sibling bot";
  }
  if (!opts.trioMode && label !== "mia") return "not mentioned (solo mode)";
  return "unaddressed channel chatter (not the concierge)";
}
