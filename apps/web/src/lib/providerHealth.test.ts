// providerHealth.test.ts — pure logic of the provider auto-failover watchdog.
// No disk writes, no network: applyFailure/applySuccess/buildChain shouldProbeProvider.

import { describe, it, expect } from "vitest";
import {
  applyFailure,
  applySuccess,
  buildChain,
  shouldProbeProvider,
  type ProviderHealth,
} from "./providerHealth";
import type { ProviderId } from "./providers";

type Res = { url: string; apiKey: string; defaultModel: string };

const RES: Res = { url: "https://example.test/v1", apiKey: "k", defaultModel: "m" };
const resolveAll: (id: ProviderId) => Res | null = () => RES;

const QUOTA_ERR = new Error("LLM failed (429) GoUsageLimitError: Monthly usage limit reached");
const TRANSIENT_ERR = new Error("Provider error (503): Upstream error from Nvidia");
const CODE_ERR = new Error("ReferenceError: foo is not defined");

function down(h: Partial<ProviderHealth>, now: number): ProviderHealth {
  return {
    status: "down",
    failCount: 3,
    cooldownUntil: new Date(now + 5 * 60 * 1000).toISOString(),
    lastCheckedAt: new Date(now).toISOString(),
    ...h,
  };
}

describe("applyFailure", () => {
  const ok: ProviderHealth = { status: "ok", failCount: 0, lastCheckedAt: "" };

  it("quota hit → down + 24h cooldown + quotaHitAt", () => {
    const now = 1_700_000_000_000;
    const h = applyFailure(ok, QUOTA_ERR, now);
    expect(h.status).toBe("down");
    expect(h.failCount).toBe(1);
    expect(h.quotaHitAt).toBe(new Date(now).toISOString());
    expect(Date.parse(h.cooldownUntil!)).toBe(now + 24 * 60 * 60 * 1000);
  });

  it("transient failures only go down after FAIL_THRESHOLD (3)", () => {
    const now = 1_700_000_000_000;
    const once = applyFailure(ok, TRANSIENT_ERR, now);
    expect(once.status).toBe("ok");
    expect(once.failCount).toBe(1);
    const twice = applyFailure(once, TRANSIENT_ERR, now + 1000);
    expect(twice.status).toBe("ok");
    expect(twice.failCount).toBe(2);
    const third = applyFailure(twice, TRANSIENT_ERR, now + 2000);
    expect(third.status).toBe("down");
    expect(Date.parse(third.cooldownUntil!)).toBe(now + 2000 + 5 * 60 * 1000);
    expect(third.quotaHitAt).toBeUndefined();
  });

  it("non-retryable (code) errors never mark a provider down", () => {
    const h = applyFailure(ok, CODE_ERR, 1_700_000_000_000);
    expect(h.status).toBe("ok");
    expect(h.failCount).toBe(0);
  });
});

describe("applySuccess", () => {
  it("clears down → ok, resets failCount, drops cooldown/lastError", () => {
    const now = 1_700_000_000_000;
    const h = applySuccess(down({ lastError: "boom" }, now), now);
    expect(h.status).toBe("ok");
    expect(h.failCount).toBe(0);
    expect(h.cooldownUntil).toBeUndefined();
    expect(h.lastError).toBeUndefined();
  });

  it("keeps an already-ok record untouched", () => {
    const ok: ProviderHealth = { status: "ok", failCount: 0, lastCheckedAt: "" };
    expect(applySuccess(ok, 1_700_000_000_000)).toBe(ok);
  });
});

describe("buildChain", () => {
  const now = 1_700_000_000_000;
  const emptyState = { providers: {}, updatedAt: "" } as const;

  it("desired first, then ranked fallbacks (configured only)", () => {
    const ids = buildChain("opencodego", emptyState, resolveAll, now).map((c) => c.id);
    expect(ids[0]).toBe("opencodego");
    expect(ids).toEqual(["opencodego", "9router", "groq", "openrouter", "opencode"]);
  });

  it("skips a provider down within its cooldown", () => {
    const state = {
      providers: {
        opencodego: down({}, now),
        "9router": down({}, now),
      },
      updatedAt: "",
    };
    const ids = buildChain("opencodego", state, resolveAll, now).map((c) => c.id);
    expect(ids).not.toContain("opencodego");
    expect(ids).not.toContain("9router");
    expect(ids[0]).toBe("groq");
  });

  it("re-admits a provider whose cooldown expired", () => {
    const state = {
      providers: {
        opencodego: down({}, now - 25 * 60 * 60 * 1000), // cooldown 5m, 25h ago → expired
      },
      updatedAt: "",
    };
    const ids = buildChain("opencodego", state, resolveAll, now).map((c) => c.id);
    expect(ids[0]).toBe("opencodego");
  });

  it("filters unconfigured providers (resolveFn null)", () => {
    const resolveOnly: (id: ProviderId) => Res | null = (id) => (id === "groq" ? RES : null);
    const ids = buildChain("opencodego", emptyState, resolveOnly, now).map((c) => c.id);
    expect(ids).toEqual(["groq"]);
  });

  it("empty when everything is down-cooling or unconfigured", () => {
    const state = { providers: { groq: down({}, now) }, updatedAt: "" };
    const resolveOnly: (id: ProviderId) => Res | null = (id) => (id === "groq" ? RES : null);
    expect(buildChain("groq", state, resolveOnly, now)).toEqual([]);
  });
});

describe("shouldProbeProvider", () => {
  const now = 1_700_000_000_000;
  const base = { providers: {} as Record<string, ProviderHealth>, updatedAt: "" };

  it("false for billed providers (opencodego) — probing spends their quota", () => {
    expect(shouldProbeProvider("opencodego", { ...base, providers: { opencodego: down({}, now) } }, now)).toBe(false);
  });

  it("false for healthy providers", () => {
    expect(shouldProbeProvider("groq", base, now)).toBe(false);
  });

  it("true for a down cheap provider due for a probe (1×/h)", () => {
    expect(shouldProbeProvider("groq", { ...base, providers: { groq: down({}, now) } }, now)).toBe(true);
  });

  it("false when probed within the last hour", () => {
    const state = {
      providers: { "9router": down({ lastProbeAt: new Date(now - 60_000).toISOString() }, now) },
      updatedAt: "",
    };
    expect(shouldProbeProvider("9router", state, now)).toBe(false);
  });
});