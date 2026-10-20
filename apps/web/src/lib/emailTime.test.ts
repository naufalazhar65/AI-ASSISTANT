import { describe, it, expect } from "vitest";
import { senderDisplayName, maskAddress } from "./email";
import { dateTimeLabel, tzLabel, userTimeZone } from "./time";

describe("sender privacy (§4)", () => {
  it("uses the display name and never the full address", () => {
    expect(senderDisplayName("Home Credit Indonesia <donotreply@homecredit.co.id>")).toBe("Home Credit Indonesia");
    expect(senderDisplayName('"Google" <noreply-accounts@google.com>')).toBe("Google");
  });
  it("masks a bare address", () => {
    expect(senderDisplayName("donotreply@homecredit.co.id")).toBe("d***@homecredit.co.id");
    expect(maskAddress("donotreply@homecredit.co.id")).toBe("d***@homecredit.co.id");
  });
  it("leaves a plain name alone", () => {
    expect(senderDisplayName("Notifikasi Bank")).toBe("Notifikasi Bank");
    expect(senderDisplayName("")).toBe("");
  });
});

describe("timestamps (§9)", () => {
  it("renders in the configured timezone", () => {
    expect(dateTimeLabel(new Date("2026-10-20T07:45:38Z"), "Asia/Jakarta", "WIB")).toBe("20 Okt 2026, 14.45 WIB");
  });
  it("uses a different zone when the app is configured for one", () => {
    // Makassar is UTC+8 → 07:45Z is 15:45 WITA (not 16.45: WITA is +8, WIT is +9).
    expect(dateTimeLabel(new Date("2026-10-20T07:45:38Z"), "Asia/Makassar", "WITA")).toBe("20 Okt 2026, 15.45 WITA");
    expect(dateTimeLabel(new Date("2026-10-20T07:45:38Z"), "Asia/Jayapura", "WIT")).toBe("20 Okt 2026, 16.45 WIT");
  });
  it("never fabricates a date", () => {
    expect(dateTimeLabel(null)).toBe("");
    expect(dateTimeLabel(undefined)).toBe("");
    expect(dateTimeLabel("")).toBe("");
    expect(dateTimeLabel("bukan tanggal")).toBe("");
  });
  it("labels only the zone it belongs to", () => {
    expect(tzLabel("Asia/Jakarta")).toBe("WIB");
    expect(tzLabel("Asia/Makassar")).toBe("WITA");
    expect(tzLabel("Asia/Jayapura")).toBe("WIT");
    expect(tzLabel("Europe/Berlin")).toBe("Europe/Berlin");
    expect(userTimeZone()).toBeTruthy();
  });
});
