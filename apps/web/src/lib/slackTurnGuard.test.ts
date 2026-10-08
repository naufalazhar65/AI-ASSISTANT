import { describe, it, expect, beforeEach } from "vitest";
import {
  BOT_HOP_LIMIT,
  CHAIN_TTL_MS,
  OWNER_TURN_REPLY_CAP,
  __resetSlackTurnGuard,
  decideSlackChain,
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
