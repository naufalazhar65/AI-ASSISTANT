import { describe, it, expect, beforeEach } from "vitest";
import {
  BOT_BURST_LIMIT,
  BOT_HOP_LIMIT,
  BURST_WINDOW_MS,
  CHAIN_TTL_MS,
  OWNER_TURN_REPLY_CAP,
  __resetBotBurst,
  __resetSlackTurnGuard,
  decideBotBurst,
  decideSlackChain,
  evaluateBotBurst,
  evaluateSlackMessage,
  slackChainKey,
  type SlackChainState,
} from "./slackTurnGuard";

const fresh = (): SlackChainState => ({ hops: 0, ownerReplies: 0, at: 1000 });

describe("slackChainKey", () => {
  it("scopes a thread separately from the channel root", () => {
    expect(slackChainKey("C1", "1700.1")).toBe("C1:1700.1");
    expect(slackChainKey("C1", null)).toBe("C1:(top)");
    expect(slackChainKey("C1", "  ")).toBe("C1:(top)");
  });

  it("keeps two threads in one channel independent", () => {
    expect(slackChainKey("C1", "t1")).not.toBe(slackChainKey("C1", "t2"));
  });
});

describe("decideSlackChain (pure rules)", () => {
  it("never gates the owner", () => {
    const v = decideSlackChain(
      { hops: 9, ownerReplies: 9, at: 1000 },
      { fromBot: false, from: "agnes", to: "mia" },
      1000
    );
    expect(v.allow).toBe(true);
  });

  it("refuses a bot reading its own message (self-echo)", () => {
    const v = decideSlackChain(fresh(), { fromBot: true, from: "mia", to: "mia" }, 1000);
    expect(v.allow).toBe(false);
    expect(v.allow === false && v.reason).toBe("self-echo");
  });

  it("allows one sibling reply, then closes the chain", () => {
    const first = decideSlackChain(fresh(), { fromBot: true, from: "agnes", to: "mia" }, 1000);
    expect(first.allow).toBe(true);
    expect(first.allow && first.hops).toBe(0);

    const spent = { ...fresh(), hops: 1, ownerReplies: 1 };
    const second = decideSlackChain(spent, { fromBot: true, from: "michelle", to: "mia" }, 1000);
    expect(second.allow).toBe(false);
    expect(second.allow === false && second.reason).toBe("hop-limit");
  });

  it("caps bot replies per owner turn even when hops remain", () => {
    const wide = { ...fresh(), hops: 0, ownerReplies: OWNER_TURN_REPLY_CAP };
    const v = decideSlackChain(wide, { fromBot: true, from: "agnes", to: "michelle" }, 1000);
    expect(v.allow).toBe(false);
    expect(v.allow === false && v.reason).toBe("owner-cap");
  });

  it("treats a chain older than the TTL as a fresh conversation", () => {
    const stale = { ...fresh(), hops: BOT_HOP_LIMIT, ownerReplies: 1, at: 1000 };
    const v = decideSlackChain(
      stale,
      { fromBot: true, from: "agnes", to: "mia" },
      1000 + CHAIN_TTL_MS + 1
    );
    expect(v.allow).toBe(true);
    expect(v.allow && v.hops).toBe(0);
  });
});

describe("evaluateSlackMessage (stateful)", () => {
  beforeEach(() => __resetSlackTurnGuard());

  it("bounds a real three-bot ping-pong to one reply", () => {
    const key = slackChainKey("C1", "t1");
    // Owner asks; Mia answers. Then Michelle speaks, Mia may answer once.
    expect(evaluateSlackMessage(key, { fromBot: false, from: "agnes", to: "mia" }).allow).toBe(true);
    expect(
      evaluateSlackMessage(key, { fromBot: true, from: "michelle", to: "mia" }).allow
    ).toBe(true);
    // Agnes replying to Mia's answer must be refused: chain is spent.
    const third = evaluateSlackMessage(key, { fromBot: true, from: "agnes", to: "michelle" });
    expect(third.allow).toBe(false);
    expect(third.allow === false && third.reason).toBe("hop-limit");
  });

  it("does not let one bot loop on itself", () => {
    const key = slackChainKey("C1", "t2");
    evaluateSlackMessage(key, { fromBot: false, from: "agnes", to: "mia" });
    for (let i = 0; i < 5; i += 1) {
      const v = evaluateSlackMessage(key, { fromBot: true, from: "mia", to: "mia" });
      expect(v.allow === false && v.reason).toBe("self-echo");
    }
  });

  it("an owner message restores the allowance", () => {
    const key = slackChainKey("C1", "t3");
    evaluateSlackMessage(key, { fromBot: false, from: "agnes", to: "mia" });
    expect(evaluateSlackMessage(key, { fromBot: true, from: "michelle", to: "mia" }).allow).toBe(true);
    expect(evaluateSlackMessage(key, { fromBot: true, from: "agnes", to: "michelle" }).allow).toBe(false);

    // Owner speaks again -> the whole chain resets, not just the hop counter.
    expect(evaluateSlackMessage(key, { fromBot: false, from: "agnes", to: "mia" }).allow).toBe(true);
    expect(evaluateSlackMessage(key, { fromBot: true, from: "michelle", to: "mia" }).allow).toBe(true);
  });

  it("expires a dormant chain instead of resurrecting a spent budget", () => {
    const key = slackChainKey("C1", "t4");
    const t0 = 1_000_000;
    evaluateSlackMessage(key, { fromBot: false, from: "agnes", to: "mia" }, t0);
    expect(evaluateSlackMessage(key, { fromBot: true, from: "michelle", to: "mia" }, t0).allow).toBe(true);
    expect(
      evaluateSlackMessage(key, { fromBot: true, from: "agnes", to: "michelle" }, t0).allow
    ).toBe(false);
    // Well past TTL: same message shape is answerable again.
    expect(
      evaluateSlackMessage(key, { fromBot: true, from: "agnes", to: "michelle" }, t0 + CHAIN_TTL_MS + 1)
        .allow
    ).toBe(true);
  });

  it("bounds each thread of a channel independently", () => {
    const a = slackChainKey("C1", "ta");
    const b = slackChainKey("C1", "tb");
    evaluateSlackMessage(a, { fromBot: false, from: "agnes", to: "mia" });
    expect(evaluateSlackMessage(a, { fromBot: true, from: "michelle", to: "mia" }).allow).toBe(true);
    expect(evaluateSlackMessage(a, { fromBot: true, from: "agnes", to: "michelle" }).allow).toBe(false);
    // Fresh thread -> untouched budget.
    expect(evaluateSlackMessage(b, { fromBot: true, from: "agnes", to: "michelle" }).allow).toBe(true);
  });
});

describe("initiatesChain — a fresh bot post is a new conversation, not a spent hop (live 2026-10-08)", () => {
  const base = (): SlackChainState => ({ hops: 0, ownerReplies: 0, at: Date.now() });

  it("allows two successive TOP-LEVEL bot posts (previously the 2nd died as hop-limit)", () => {
    const first = decideSlackChain(base(), {
      fromBot: true, from: "mia", to: "agnes", initiatesChain: true,
    });
    expect(first.allow).toBe(true);
    const spent = { hops: first.hops, ownerReplies: first.ownerReplies, at: Date.now() };
    const second = decideSlackChain(spent, {
      fromBot: true, from: "mia", to: "michelle", initiatesChain: true,
    });
    expect(second.allow).toBe(true);
  });

  it("still bounds a THREAD: a reply inside the chain is a hop and only one is allowed", () => {
    const after = decideSlackChain(base(), {
      fromBot: true, from: "mia", to: "agnes", initiatesChain: true,
    });
    const hop1 = decideSlackChain(
      { hops: after.hops, ownerReplies: after.ownerReplies, at: Date.now() },
      { fromBot: true, from: "agnes", to: "mia" }
    );
    expect(hop1.allow).toBe(true);
    const hop2 = decideSlackChain(
      { hops: hop1.hops + 1, ownerReplies: hop1.ownerReplies + 1, at: Date.now() },
      { fromBot: true, from: "agnes", to: "mia" }
    );
    expect(hop2).toMatchObject({ allow: false, reason: "hop-limit" });
  });

  it("a fresh initiator never revives a self-echo", () => {
    const verdict = decideSlackChain(base(), {
      fromBot: true, from: "mia", to: "mia", initiatesChain: true,
    });
    expect(verdict).toMatchObject({ allow: false, reason: "self-echo" });
  });

  it("owner turns are never gated, initiator flag included", () => {
    const verdict = decideSlackChain(
      { hops: 9, ownerReplies: 9, at: Date.now() },
      { fromBot: false, from: "mia", to: "mia", initiatesChain: true }
    );
    expect(verdict.allow).toBe(true);
  });

  it("stateful: top-level posts get their own budget each, replies share the thread's", () => {
    __resetSlackTurnGuard();
    const now = Date.now();
    const top = "C_TOP:C_TOP_INIT";
    expect(evaluateSlackMessage(top, { fromBot: true, from: "mia", to: "agnes", initiatesChain: true }, now).allow).toBe(true);
    // Agnes replies in Mia's thread: separate key, one hop of its own.
    const thread = "C_TOP:C_TOP_INIT_TS";
    expect(evaluateSlackMessage(thread, { fromBot: true, from: "agnes", to: "mia" }, now + 1).allow).toBe(true);
    expect(evaluateSlackMessage(thread, { fromBot: true, from: "agnes", to: "mia" }, now + 2).allow).toBe(false);
    // A brand new top-level post is unaffected by the exhausted thread.
    expect(evaluateSlackMessage(top, { fromBot: true, from: "mia", to: "michelle", initiatesChain: true }, now + 3).allow).toBe(true);
    __resetSlackTurnGuard();
  });
});

// Live incident 2026-10-12: the provider died (`403 ... An active OpenCode Go
// subscription is required to use Go models`) and Agnes <-> Michelle produced
// ~80 alternating turns in one channel. The hop budget could not stop it — see
// these tests for why — so the burst brake bounds the channel instead.
describe("burst brake (the limit no bot message can reset)", () => {
  beforeEach(() => __resetBotBurst());

  it("the owner is never gated, however loud the channel got", () => {
    const v = decideBotBurst(
      { count: 99, at: 1000 },
      { fromBot: false },
      1000
    );
    expect(v).toMatchObject({ allow: true, count: 0 });
  });

  it("stops the cascade once the window budget is spent", () => {
    let state = { count: 0, at: 1000 };
    for (let i = 0; i < BOT_BURST_LIMIT; i += 1) {
      const v = decideBotBurst(state, { fromBot: true }, 1000);
      expect(v.allow).toBe(true);
      state = { count: v.allow ? v.count : 0, at: 1000 };
    }
    const denied = decideBotBurst(state, { fromBot: true }, 1000);
    expect(denied).toMatchObject({ allow: false, reason: "burst-limit" });
  });

  it("a bot message CANNOT reset it — only time or the owner can (the unthreaded-reply hole)", () => {
    let state = { count: 0, at: 1000 };
    for (let i = 0; i < BOT_BURST_LIMIT; i += 1) {
      const v = decideBotBurst(state, { fromBot: true }, 1000);
      state = { count: v.allow ? v.count : 0, at: 1000 };
    }
    // Denied now...
    expect(decideBotBurst(state, { fromBot: true }, 1000).allow).toBe(false);
    // ...and still denied for every following bot message, however it is shaped.
    for (let i = 0; i < 20; i += 1) {
      expect(decideBotBurst(state, { fromBot: true }, 1000 + i).allow).toBe(false);
    }
    // Only the rolling window lapsing re-opens the channel.
    expect(decideBotBurst(state, { fromBot: true }, 1000 + BURST_WINDOW_MS + 1).allow).toBe(true);
  });

  it("an owner message clears the whole counter (fresh allowance)", () => {
    const v = evaluateBotBurst("C1:(top)", { fromBot: false });
    expect(v.allow).toBe(true);
    for (let i = 0; i < BOT_BURST_LIMIT; i += 1) {
      evaluateBotBurst("C1:(top)", { fromBot: true });
    }
    expect(evaluateBotBurst("C1:(top)", { fromBot: true }).allow).toBe(false);
    // Owner speaks -> counter cleared -> the trio can work again immediately.
    expect(evaluateBotBurst("C1:(top)", { fromBot: false }).allow).toBe(true);
    expect(evaluateBotBurst("C1:(top)", { fromBot: true }).allow).toBe(true);
  });

  it("bounds each channel independently", () => {
    for (let i = 0; i < BOT_BURST_LIMIT; i += 1) evaluateBotBurst("A:(top)", { fromBot: true });
    expect(evaluateBotBurst("A:(top)", { fromBot: true }).allow).toBe(false);
    expect(evaluateBotBurst("B:(top)", { fromBot: true }).allow).toBe(true);
  });

  it("the stateful wrapper does not resurrect a stale entry past the window", () => {
    const t0 = 2_000_000;
    evaluateBotBurst("C1:(top)", { fromBot: true }, t0);
    const later = evaluateBotBurst("C1:(top)", { fromBot: true }, t0 + BURST_WINDOW_MS + 1);
    expect(later.allow).toBe(true);
    expect(later.allow && later.count).toBe(1);
  });
});

describe("the two limits answer different questions (both are needed)", () => {
  beforeEach(() => {
    __resetSlackTurnGuard();
    __resetBotBurst();
  });

  it("hop limit closes ONE conversation; the brake stops an endless supply of new ones", () => {
    const key = slackChainKey("C1", "1700.1");
    // Two legitimate handoffs (top-level posts = new conversations) both pass.
    expect(
      evaluateSlackMessage(key, { fromBot: true, from: "michelle", to: "agnes", initiatesChain: true }).allow
    ).toBe(true);
    expect(
      evaluateSlackMessage(key, { fromBot: true, from: "agnes", to: "michelle", initiatesChain: true }).allow
    ).toBe(true);
    expect(evaluateBotBurst(key, { fromBot: true }).allow).toBe(true);
    expect(evaluateBotBurst(key, { fromBot: true }).allow).toBe(true);

    // Both independent: a threaded reply in the same chain is hop-limited...
    const thread = slackChainKey("C1", "1700.2");
    evaluateSlackMessage(thread, { fromBot: true, from: "agnes", to: "michelle", initiatesChain: true });
    expect(evaluateSlackMessage(thread, { fromBot: true, from: "michelle", to: "agnes" }).allow).toBe(false);
    // ...while the channel brake keeps counting fresh conversations.
    for (let i = 0; i < BOT_BURST_LIMIT; i += 1) evaluateBotBurst(key, { fromBot: true });
    expect(evaluateBotBurst(key, { fromBot: true }).allow).toBe(false);
  });
});
