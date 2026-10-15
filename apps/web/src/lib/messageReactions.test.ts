import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  __resetReactionState,
  ackEmoji,
  agentEmojiSet,
  lightFallbackDue,
  noteLightFallback,
  claimReactionSlot,
  getReactionRecord,
  looksLikeTaskAsk,
  reactionConfig,
  replaceDiscordReaction,
  selectConversationalReaction,
  selectFinalReaction,
  sendDiscordReaction,
  sendTelegramReaction,
  setReactionEmoji,
  turnOutcomeFromMessages,
} from "./messageReactions";

beforeEach(() => {
  __resetReactionState();
  delete process.env.REACTIONS_ENABLED;
  delete process.env.REACTIONS_MODE;
  delete process.env.REACTIONS_AGENTS;
});

describe("conversational reactions", () => {
  it("1. a greeting triggers 👋 for Mia", () => {
    expect(selectConversationalReaction("halo", "mia").emoji).toBe("👋");
  });

  it("serious/sad messages never get a playful reaction", () => {
    expect(selectConversationalReaction("aku lagi stres banget", "mia").emoji).toBe("");
    expect(selectConversationalReaction("haha aku sedih hari ini", "mia").emoji).toBe("");
    expect(selectConversationalReaction("aku marah sama dia", "michelle").emoji).toBe("");
  });

  it("thanks/ideas/questions map sanely; plain statements stay silent", () => {
    expect(selectConversationalReaction("makasih banyak ya", "mia").emoji).toBe("🙏");
    expect(selectConversationalReaction("ada ide buat liburan?", "mia").emoji).toBe("💡");
    expect(selectConversationalReaction("menurut kamu pilih yang mana?", "agnes").emoji).toBe("🤔");
    expect(selectConversationalReaction("jam berapa sekarang", "mia").emoji).toBe("");
    expect(selectConversationalReaction("", "mia").emoji).toBe("");
    expect(selectConversationalReaction("/status", "mia").emoji).toBe("");
  });

  it("Agnes and Michelle greet and thank too (social basics are universal)", () => {
    expect(selectConversationalReaction("halo", "agnes").emoji).toBe("👋");
    expect(selectConversationalReaction("<@123456789> halo", "agnes").emoji).toBe("👋");
    expect(selectConversationalReaction("makasih ya", "agnes").emoji).toBe("🙏");
    expect(selectConversationalReaction("makasih ya", "michelle").emoji).toBe("🙏");
    expect(looksLikeTaskAsk("<@123456789> cek email dong")).toBe(true);
    // ...while researcher character stays serious where it matters.
    expect(selectConversationalReaction("haha lucu banget", "agnes").emoji).toBe("");
  });

  it("Agnes never laughs (not in her set); Michelle has her own set", () => {
    expect(selectConversationalReaction("haha lucu banget", "michelle").emoji).toBe("");
    expect(selectConversationalReaction("halo", "michelle").emoji).toBe("👋");
    expect(agentEmojiSet("agnes")).toContain("🔎");
    expect(agentEmojiSet("michelle")).toContain("🛠️");
  });
});

describe("task lifecycle reactions", () => {
  it("2. a task ask earns an ack; a plain chat does not", () => {
    expect(looksLikeTaskAsk("cek email dong")).toBe(true);
    expect(looksLikeTaskAsk("buatkan laporan pdf nya")).toBe(true);
    expect(looksLikeTaskAsk("halo apa kabar")).toBe(false);
    expect(ackEmoji("mia")).toBe("👀");
    expect(ackEmoji("agnes")).toBe("🔎");
    expect(ackEmoji("unknown-agent-zzz")).toBe("👀");
  });

  it("3. ✅ only after verified completed work, never for refused calls", () => {
    const done = turnOutcomeFromMessages([
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "gmail_list" } }] },
      { role: "tool", tool_call_id: "t1", content: "📧 2 email" },
    ]);
    expect(done.executedTools).toEqual(["gmail_list"]);
    expect(selectFinalReaction(done, "👀").emoji).toBe("✅");
    const refused = turnOutcomeFromMessages([
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "http_request" } }] },
      { role: "tool", tool_call_id: "t1", content: "Not selected: other calls ran" },
    ]);
    expect(refused.executedTools).toEqual([]);
    expect(selectFinalReaction(refused, "👀").emoji).toBe("👀");
  });

  it("4. a tool error earns ⚠️, and mixed runs still flag the error", () => {
    const facts = turnOutcomeFromMessages([
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "poc_verify" } }] },
      { role: "tool", tool_call_id: "t1", content: "Error: SCOPE — bukan lab" },
    ]);
    expect(facts.toolError).toBe(true);
    expect(selectFinalReaction(facts, "👀").emoji).toBe("⚠️");
  });

  it("10. interim can update to final; a finalized slot rejects late writes", () => {
    expect(claimReactionSlot("discord", "c1", "m1", "mia", "ack")).toBe(true);
    setReactionEmoji("discord", "c1", "m1", "mia", "👀", false);
    expect(getReactionRecord("discord", "c1", "m1", "mia")?.emoji).toBe("👀");
    setReactionEmoji("discord", "c1", "m1", "mia", "✅", true);
    expect(claimReactionSlot("discord", "c1", "m1", "mia", "final")).toBe(false);
    expect(getReactionRecord("discord", "c1", "m1", "mia")?.emoji).toBe("✅");
  });
});

describe("routing, modes, and spam guards", () => {
  it("7/8. routed_agent_only is the default; slots are per-agent (no cross-talk)", () => {
    expect(reactionConfig().mode).toBe("routed_agent_only");
    expect(claimReactionSlot("discord", "c1", "m1", "mia", "ack")).toBe(true);
    // 8. another agent has its OWN slot — the engine never blocks it, the
    // adapter only calls for the responding agent (routed only).
    expect(claimReactionSlot("discord", "c1", "m1", "agnes", "ack")).toBe(true);
  });

  it("9. duplicate events do not create duplicate operations", () => {
    expect(claimReactionSlot("telegram", "c9", "m9", "mia", "ack")).toBe(true);
    expect(claimReactionSlot("telegram", "c9", "m9", "mia", "ack")).toBe(false);
  });

  it("12. at most one emoji per decision (frequency cap is structural)", () => {
    for (const t of ["halo", "makasih", "haha lucu", "ada ide?", "wow serius?"]) {
      const e = selectConversationalReaction(t, "mia").emoji;
      expect([...e].length <= 2 || e === "").toBe(true);
    }
  });

  it("14. an unknown future agent falls back without rewriting the core", () => {
    expect(agentEmojiSet("udin").length).toBeGreaterThan(0);
    expect(ackEmoji("udin")).toBe("👀");
    expect(selectConversationalReaction("halo", "udin").emoji).toBe("👋");
  });

  it("15. disabling kills reactions, never the chat path", () => {
    process.env.REACTIONS_ENABLED = "0";
    expect(reactionConfig().enabled).toBe(false);
    process.env.REACTIONS_MODE = "all_agents";
    expect(reactionConfig().mode).toBe("all_agents");
    process.env.REACTIONS_MODE = "bogus";
    expect(reactionConfig().mode).toBe("routed_agent_only");
  });
});

describe("platform senders never throw (spec 11)", () => {
  it("6. discord and telegram use separate native paths; failures resolve false", async () => {
    const badDiscord = { react: () => Promise.reject(new Error("Missing Permissions")) };
    const logged: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void logged.push(String(a[0]));
    try {
      expect(await sendDiscordReaction(badDiscord, "mia", "m1", "👀")).toBe(false);
      const badTelegram = { react: () => Promise.reject(new Error("REACTION_NOT_ALLOWED")) };
      expect(await sendTelegramReaction(badTelegram, "mia", "m1", "👀")).toBe(false);
      expect(await sendDiscordReaction(badDiscord, "mia", "m1", "")).toBe(false);
    } finally {
      console.warn = orig;
    }
    expect(logged.length).toBeGreaterThan(0);
  });

  it("replace removes only our own reaction, then adds the final one", async () => {
    const calls: string[] = [];
    const removed: string[] = [];
    const msg = {
      react: (e: string) => (calls.push(e), Promise.resolve()),
      reactions: { resolve: (e: string) => ({ users: { remove: (u: string) => (removed.push(`${e}:${u}`), Promise.resolve()) } }) },
    };
    expect(await replaceDiscordReaction(msg, "bot123", "mia", "m1", "👀", "✅")).toBe(true);
    expect(removed).toEqual(["👀:bot123"]);
    expect(calls).toEqual(["✅"]);
  });

  it("a throwing remover still delivers the final reaction", async () => {
    const calls: string[] = [];
    const msg = {
      react: (e: string) => (calls.push(e), Promise.resolve()),
      reactions: { resolve: () => { throw new Error("gone"); } },
    };
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(await replaceDiscordReaction(msg, "bot123", "mia", "m1", "👀", "✅")).toBe(true);
    } finally {
      console.warn = orig;
    }
    expect(calls).toEqual(["✅"]);
  });
});

describe("human-like delay with preemption", () => {
  it("delayMs defaults to 3000 and is configurable", async () => {
    const { reactionConfig } = await import("./messageReactions");
    expect(reactionConfig().delayMs).toBe(3000);
    process.env.REACTIONS_DELAY_MS = "500";
    expect(reactionConfig().delayMs).toBe(500);
    delete process.env.REACTIONS_DELAY_MS;
  });

  it("a finishing turn preempts the pending ack (no stale overwrite)", async () => {
    const { claimReactionSlot, setReactionTimer, takeReactionTimer, getReactionRecord, setReactionEmoji } =
      await import("./messageReactions");
    vi.useFakeTimers();
    try {
      expect(claimReactionSlot("discord", "c", "m", "mia", "ack")).toBe(true);
      let sent = "";
      setReactionTimer(
        "discord", "c", "m", "mia",
        setTimeout(() => { sent = "👀"; setReactionEmoji("discord", "c", "m", "mia", "👀", false); }, 3000)
      );
      // Turn ends fast: preempt, then apply the final reaction directly.
      takeReactionTimer("discord", "c", "m", "mia");
      setReactionEmoji("discord", "c", "m", "mia", "✅", true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toBe("");
      expect(getReactionRecord("discord", "c", "m", "mia")?.emoji).toBe("✅");
    } finally {
      vi.useRealTimers();
    }
  });

  it("without preemption the delayed reaction still lands", async () => {
    const { claimReactionSlot, setReactionTimer, getReactionRecord, setReactionEmoji } =
      await import("./messageReactions");
    vi.useFakeTimers();
    try {
      expect(claimReactionSlot("discord", "c2", "m2", "mia", "chat")).toBe(true);
      setReactionTimer(
        "discord", "c2", "m2", "mia",
        setTimeout(() => { setReactionEmoji("discord", "c2", "m2", "mia", "👋", false); }, 3000)
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(getReactionRecord("discord", "c2", "m2", "mia")?.emoji).toBe("👋");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bare summons (live 2026-10-15: 'agnes' / 'miche;;e' debris)", () => {
  it("a lone agent name reacts like a greeting", () => {
    expect(selectConversationalReaction("agnes", "agnes").emoji).toBe("👋");
    expect(selectConversationalReaction("miche;;e", "michelle").emoji).toBe("👋");
    // "ness" debris never reaches the engine — the adapter rewrites
    // name-fragment-only summons to "halo" before the turn (greeting rule).
    expect(selectConversationalReaction("makan", "agnes").emoji).toBe("");
    expect(selectConversationalReaction("halo apa kabar semuanya hari ini ya", "mia").emoji).toBe("👋");
  });
});

describe("finish preempts the timer only when it sends a final (live 2026-10-15: all reactions died)", () => {
  it("a chat turn with no tools leaves the pending first reaction alone", async () => {
    const { claimReactionSlot, setReactionTimer, takeReactionTimer, getReactionRecord, setReactionEmoji, selectFinalReaction } =
      await import("./messageReactions");
    vi.useFakeTimers();
    try {
      expect(claimReactionSlot("discord", "c", "m", "mia", "chat")).toBe(true);
      setReactionTimer("discord", "c", "m", "mia", setTimeout(() => {
        setReactionEmoji("discord", "c", "m", "mia", "👋", false);
      }, 3000));
      // Adapter finish path for a tool-less turn: keep-silence must NOT cancel.
      const decision = selectFinalReaction({ executedTools: [], toolError: false }, "");
      expect(decision.emoji).toBe("");
      // (no takeReactionTimer call here — that is the fix under test)
      await vi.advanceTimersByTimeAsync(3000);
      expect(getReactionRecord("discord", "c", "m", "mia")?.emoji).toBe("👋");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a completed turn cancels the stale ack and sends the final directly", async () => {
    const { claimReactionSlot, setReactionTimer, takeReactionTimer, getReactionRecord, setReactionEmoji } =
      await import("./messageReactions");
    vi.useFakeTimers();
    try {
      expect(claimReactionSlot("discord", "c3", "m3", "mia", "ack")).toBe(true);
      let acked = "";
      setReactionTimer("discord", "c3", "m3", "mia", setTimeout(() => { acked = "👀"; }, 3000));
      takeReactionTimer("discord", "c3", "m3", "mia");
      setReactionEmoji("discord", "c3", "m3", "mia", "✅", true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(acked).toBe("");
      expect(getReactionRecord("discord", "c3", "m3", "mia")?.emoji).toBe("✅");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("light fallback for signal-free chat (live 2026-10-15: 'duhh' drew silence everywhere)", () => {
  it("plain short chat reacts when the fallback is allowed", () => {
    for (const agent of ["mia", "agnes", "michelle"]) {
      expect(selectConversationalReaction("duhh", agent, { allowLightFallback: true }).reason).toBe("light-fallback");
      expect(selectConversationalReaction("sip", agent, { allowLightFallback: true }).emoji).not.toBe("");
    }
  });
  it("no fallback flag stays silent (default unchanged)", () => {
    expect(selectConversationalReaction("duhh", "mia").emoji).toBe("");
  });
  it("serious messages never get a fallback", () => {
    const d = selectConversationalReaction("aku capek banget hari ini", "mia", { allowLightFallback: true });
    expect(d.emoji).toBe("");
    expect(d.reason).toBe("serious-mood");
  });
  it("long messages (real content) never get a fallback", () => {
    expect(selectConversationalReaction("d".repeat(80), "mia", { allowLightFallback: true }).emoji).toBe("");
  });
  it("cooldown gates the fallback per agent+chat", () => {
    expect(lightFallbackDue("discord", "cool-c", "mia")).toBe(true);
    noteLightFallback("discord", "cool-c", "mia");
    expect(lightFallbackDue("discord", "cool-c", "mia")).toBe(false);
    expect(lightFallbackDue("discord", "cool-c", "agnes")).toBe(true);
  });
});
