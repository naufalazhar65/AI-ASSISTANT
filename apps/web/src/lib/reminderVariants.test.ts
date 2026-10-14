// Reminder-variant helpers (live incident 2026-10-13).
//
// An 18:59 "waktunya makan" reminder was pushed as "Hei, waktunya makan siang
// dulu ya" because the pool was authored from the bare text with no clock. These
// tests lock the two pure pieces of the fix: the daypart word and the clock line
// handed to the writer. `periodForHour` is the boundary table the prompt rules
// refer to, so its edges are asserted explicitly (a wrong edge silently moves a
// whole reminder into the wrong meal).

import { describe, expect, it } from "vitest";

import { parseVariantLines, periodForHour, variantClockContext } from "./reminderVariants";

describe("periodForHour — daypart boundaries", () => {
  it("maps every hour of the day to exactly one daypart", () => {
    expect(periodForHour(0)).toBe("larut malam");
    expect(periodForHour(4)).toBe("larut malam");
    expect(periodForHour(5)).toBe("pagi");
    expect(periodForHour(10)).toBe("pagi");
    expect(periodForHour(11)).toBe("siang");
    expect(periodForHour(14)).toBe("siang");
    expect(periodForHour(15)).toBe("sore");
    expect(periodForHour(17)).toBe("sore");
    expect(periodForHour(18)).toBe("malam");
    expect(periodForHour(23)).toBe("malam");
  });

  it("18:59 is NOT siang — the exact hour of the live bad push", () => {
    expect(periodForHour(18)).not.toBe("siang");
    expect(periodForHour(19)).not.toBe("siang");
  });
});

describe("variantClockContext — the clock the writer never had", () => {
  // 2026-10-13T18:59:00+07:00 = the reminder that shipped as "makan siang".
  const EVENING_WIB = Date.parse("2026-10-13T18:59:00+07:00");

  it("names the WIB day, clock and daypart", () => {
    const line = variantClockContext(EVENING_WIB);
    expect(line).toContain("2026-10-13");
    expect(line).toContain("18:59");
    expect(line).toContain("WIB");
    expect(line).toContain("periode malam");
    expect(line).not.toContain("periode siang");
  });

  it("follows a noon reminder into siang", () => {
    const line = variantClockContext(Date.parse("2026-10-13T12:15:00+07:00"));
    expect(line).toContain("12:15");
    expect(line).toContain("periode siang");
  });

  it("forbids the writer from printing its own clock (system appends the label)", () => {
    expect(variantClockContext(EVENING_WIB)).toContain("jangan tulis jam/tanggal");
  });

  it("uses WIB regardless of the host server zone", () => {
    // Same instant expressed as UTC: if the helper read the host zone it would
    // print 11:59 instead of 18:59 — this is the whole point of pinning WIB.
    const line = variantClockContext(Date.parse("2026-10-13T11:59:00Z"));
    expect(line).toContain("18:59");
    expect(line).toContain("2026-10-13");
  });
});

describe("parseVariantLines", () => {
  it("strips numbering, bullets and quotes, keeps at most 5 unique lines", () => {
    const out = parseVariantLines(
      ['1. "Waktunya makan ya"', "• Waktunya makan 🎽", "- Waktunya makan!", "2) Udah makan?", "3. Jangan lupa makan", "4. Makan yuk", "5. Makan sekarang"].join("\n")
    );
    expect(out).toContain("Waktunya makan ya");
    expect(out.every((l) => !/^\d|^["'•-]/.test(l))).toBe(true);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("drops blank lines and over-long lines", () => {
    const out = parseVariantLines(["", "   ", "x".repeat(200), "ok satu", "ok dua"].join("\n"));
    expect(out).toEqual(["ok satu", "ok dua"]);
  });

  it("ignores duplicate lines (case-insensitive)", () => {
    expect(parseVariantLines("Sama\ne\nSAMA\nBeda").length).toBe(3);
  });
});