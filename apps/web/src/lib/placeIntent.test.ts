import { describe, expect, it } from "vitest";
import { detectPlaceIntent, placeNudge } from "./placeIntent";

/**
 * The nudge is appended AFTER the voice firewall (agent.ts runAgent), so its
 * shape IS the last word on register. Live defect 2026-10-05 23:09: the hardcoded
 * Mia string pasted a 🌸 into Michelle's reply and closed it with a formal
 * delegating clause, breaking both of that persona's hard rules.
 */
const MIA_NUDGE =
  " (Catatan: ini rekomendasi dari ingatanku dan bisa telat — cek dulu di Google ya, siapa tau ada yang udah tutup atau pindah 🌸)";

describe("detectPlaceIntent", () => {
  it("detects recommendation/status asks", () => {
    for (const s of [
      "enaknya ngopi dimana ya di tangsel?",
      "rekomendasi cafe di jakarta",
      "kopi praja masih buka?",
      "mau makan malam enak di bintaro",
    ]) {
      expect(detectPlaceIntent(s)).toBe(true);
    }
  });

  it("ignores non-place asks", () => {
    for (const s of ["yang sepi dimana?", "hitung 2+2", "apa kabar hari ini"]) {
      expect(detectPlaceIntent(s)).toBe(false);
    }
  });
});

describe("placeNudge — when it fires at all", () => {
  it("fires when the answer is unverified", () => {
    expect(placeNudge("Kopi Praja, Bintaro: vibes industrial.", false)).not.toBe("");
  });

  it("stays silent after a successful web_search", () => {
    expect(placeNudge("Kopi Praja, Bintaro: vibes industrial.", true)).toBe("");
  });

  it("stays silent when the model already hedged", () => {
    expect(placeNudge("Coba cek dulu ya di Google ya beb.", false)).toBe("");
  });

  it("stays silent on an empty answer", () => {
    expect(placeNudge("", false)).toBe("");
  });
});

describe("placeNudge — Mia's shape is frozen", () => {
  it("is byte-identical with no agent", () => {
    expect(placeNudge("Kopi Praja, Bintaro: vibes industrial.", false)).toBe(MIA_NUDGE);
  });

  it("is byte-identical for agent=mia", () => {
    expect(placeNudge("Kopi Praja, Bintaro: vibes industrial.", false, "mia")).toBe(MIA_NUDGE);
  });

  it("fails CLOSED to Mia's shape on an unknown label", () => {
    for (const bogus of ["marcus", "", null, undefined, 7] as unknown[]) {
      expect(placeNudge("Kopi Praja, Bintaro: vibes industrial.", false, bogus as never)).toBe(MIA_NUDGE);
    }
  });
});

describe("placeNudge — the trio gets the casual shape", () => {
  it.each(["agnes", "michelle"] as const)("%s never receives Mia's glyph", (agent) => {
    expect(placeNudge("Kopi hitam paling pas.", false, agent)).not.toContain("\u{1F338}");
  });

  it.each(["agnes", "michelle"] as const)("%s never receives Mia's formal frame", (agent) => {
    const n = placeNudge("Kopi hitam paling pas.", false, agent);
    expect(n).not.toContain("Catatan:");
    expect(n).not.toContain("cek dulu di Google");
  });

  it.each(["agnes", "michelle"] as const)("%s never gets a written-Indonesian spelling", (agent) => {
    // "siapa tau" is written Indonesian; the everyday spelling is "siapa tahu".
    expect(placeNudge("Kopi hitam paling pas.", false, agent)).not.toContain("siapa tau");
  });

  it.each(["agnes", "michelle"] as const)("%s is never handed a to-do list", (agent) => {
    // The caveat is a caveat, not an instruction to go verify it themselves.
    const n = placeNudge("Kopi hitam paling pas.", false, agent);
    expect(n).not.toMatch(/cek|cek dulu|google|verif/i);
  });

  it("is a short parenthetical, not a paragraph", () => {
    const n = placeNudge("Kopi hitam paling pas.", false, "michelle");
    expect(n.startsWith(" (")).toBe(true);
    expect(n.endsWith(")")).toBe(true);
    expect(n.split(/\s+/).length).toBeLessThanOrEqual(9);
  });

  it("differs from Mia's shape (the fix is real, not a no-op)", () => {
    expect(placeNudge("Kopi hitam paling pas.", false, "michelle")).not.toBe(MIA_NUDGE);
  });

  it("still honours the silence rules for the trio", () => {
    expect(placeNudge("Kopi hitam paling pas.", true, "michelle")).toBe("");
    expect(placeNudge("Coba cek dulu ya di Google ya.", false, "agnes")).toBe("");
    expect(placeNudge("", false, "agnes")).toBe("");
  });
});