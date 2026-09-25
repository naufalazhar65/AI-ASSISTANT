// accountRecovery.test.ts — pure helpers of the account_recovery prover.
import { describe, it, expect } from "vitest";
import {
  extractResetLinks,
  linkHost,
  tokenEntropyVerdict,
  extractToken,
  enumVerdict,
  INJECT_HOSTS,
} from "./accountRecovery";
import type { RecProbe } from "./accountRecovery";

describe("extractResetLinks", () => {
  it("finds password-reset-shaped absolute URLs", () => {
    const body = 'Klik https://app.test/reset?token=abc123 untuk lanjut. Hubungi admin.';
    expect(extractResetLinks(body)).toEqual(["https://app.test/reset?token=abc123"]);
  });

  it("ignores URLs without recovery keywords", () => {
    expect(extractResetLinks("lihat https://app.test/style.css ya")).toEqual([]);
  });

  it("dedupes and strips trailing punctuation", () => {
    const body = "https://a.test/reset?t=1. https://a.test/reset?t=1)";
    expect(extractResetLinks(body)).toEqual(["https://a.test/reset?t=1"]);
  });
});

describe("linkHost", () => {
  it("extracts the host lowercase", () => {
    expect(linkHost("https://Evil.Example/reset")).toBe("evil.example");
  });
  it("returns empty for garbage", () => {
    expect(linkHost("bukan url")).toBe("");
  });
});

describe("tokenEntropyVerdict", () => {
  const long = (s: string) => s;

  it("flags identical tokens", () => {
    const t = long("abcdef0123456789");
    const v = tokenEntropyVerdict(t, t);
    expect(v.verdict).toBe("identical");
    expect(v.tokenish).toBe(true);
  });

  it("flags a long repeated prefix (timestamp-like)", () => {
    const v = tokenEntropyVerdict("202609241200abcdef", "202609241200fedcba");
    expect(v.verdict).toBe("repeated-prefix");
  });

  it("flags a tiny alphabet", () => {
    const v = tokenEntropyVerdict("0123456789ab", "9876543210ba");
    expect(v.verdict).toBe("weak-alphabet");
  });

  it("passes healthy random tokens", () => {
    const v = tokenEntropyVerdict("a1B2c3D4e5F6g7H8", "z9Y8x7W6v5U4t3S2");
    expect(v.verdict).toBe("ok");
  });

  it("is honest when no token is found", () => {
    expect(tokenEntropyVerdict(null, null).verdict).toBe("none");
    expect(tokenEntropyVerdict("short", "short").verdict).toBe("none");
  });
});

describe("extractToken", () => {
  it("pulls a tokenish value after token/code/key markers", () => {
    expect(extractToken('{"reset_token":"a1B2c3D4e5F6g7H8"}')).toBe("a1B2c3D4e5F6g7H8");
    expect(extractToken("token=a9b8c7d6e5f4")).toBe("a9b8c7d6e5f4");
  });
  it("returns null without a marker", () => {
    expect(extractToken("halo dunia")).toBeNull();
  });
});

describe("enumVerdict", () => {
  const p = (status: number, body: string): RecProbe => ({ status, body, ms: 3 });

  it("flags identical responses (enumeration lead)", () => {
    const v = enumVerdict(p(200, "email dikirim bila akun ada"), p(200, "email dikirim bila akun ada!"));
    expect(v.lead).toBe(true);
  });

  it("stays silent when responses differ", () => {
    const v = enumVerdict(p(200, "email dikirim"), p(404, "user tidak ditemukan"));
    expect(v.lead).toBe(false);
  });

  it("does not judge network errors", () => {
    const v = enumVerdict(p(0, ""), p(200, "ok"));
    expect(v.lead).toBe(false);
    expect(v.detail).toContain("network");
  });
});

describe("INJECT_HOSTS", () => {
  it("are attacker-shaped and distinct", () => {
    expect(new Set(INJECT_HOSTS).size).toBe(INJECT_HOSTS.length);
    for (const h of INJECT_HOSTS) expect(h).toContain("evil");
  });
});
