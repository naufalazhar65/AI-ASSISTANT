// Unit tests for library link-capture gating (no network).
import { describe, expect, it } from "vitest";
import { isPentestAsk, scheduleLinkCapture } from "./library";

const msgs = (userText: string) => [{ role: "user", content: userText }];

describe("isPentestAsk", () => {
  it("flags pentest/security asks", () => {
    expect(isPentestAsk("mia coba lakukan full pentest secara menyeluruh di https://lab.tld/")).toBe(true);
    expect(isPentestAsk("jalankan exploit_chain chain=idor url=https://lab.tld/api/x?id=1")).toBe(true);
    expect(isPentestAsk("buatkan report pdfnya")).toBe(true);
    expect(isPentestAsk("ringkas temuan lab ini")).toBe(false);
  });
  it("leaves normal link sharing alone", () => {
    expect(isPentestAsk("baca link ini https://artikel.tld/x, menarik")).toBe(false);
    expect(isPentestAsk("halo")).toBe(false);
  });
});

describe("scheduleLinkCapture pentest gate (audit 2026-09-22)", () => {
  it("never suffixes or captures a pentest target URL", () => {
    const out = scheduleLinkCapture(msgs("full pentest di https://lab.tld/index.html dan buatkan pdfnya"), "u", undefined, undefined, "balasan Mia");
    expect(out).toBe("balasan Mia");
    expect(out).not.toContain("daftar bacaan");
  });
  it("still suffixes a normal shared link", () => {
    const out = scheduleLinkCapture(msgs("baca ini https://artikel.tld/x"), "u", undefined, undefined, "bagus artikelnya");
    expect(out).toContain("daftar bacaan");
  });
  it("no URL, no suffix", () => {
    expect(scheduleLinkCapture(msgs("halo"), "u", undefined, undefined, "hai")).toBe("hai");
  });
});
