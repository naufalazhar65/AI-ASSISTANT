// Turn-level regression locks for the bugs found from live pushes (2026-09-17).
//
// These assert the DECISIONS, not the network: the Spotify double-play, the
// fabricated mood claim, the filler "topic", the 12-hour clock and the UTC day
// key were all pure-logic bugs, so they can be locked here (fast, no network).

import { describe, expect, it } from "vitest";
import { planSpotifyTurn, detectSpotifyAfterTrack, detectSpotifyControl, isPlaybackCommand } from "./spotifyIntent";
import { moodTone } from "./mood";
import { isFillerLine } from "./memoryNoise";
import { clockLabel, wibDay, wibDayIndex, wibDailyNext } from "./time";
import { isSilentAutomationReply } from "./automationRunner";
import { parseLatLonAnywhere } from "./geo";
import { resolveFavoriteQuery } from "./spotify";

const t = (iso: string) => new Date(iso).getTime();

describe("spotify turn routing (no double action)", () => {
  it("falls back to play only when the model did NOT already play", () => {
    expect(planSpotifyTurn("mia play lagu favoritku dari m2m", new Set())).toBe("play");
    expect(planSpotifyTurn("mia play lagu favoritku dari m2m", new Set(["spotify_play"]))).toBe("none");
  });

  it("routes 'stop kalau lagunya selesai' to the sleep timer, never an immediate pause", () => {
    expect(detectSpotifyAfterTrack("oke kalo lagunya udh selesai stop aja ya")).toBe(true);
    expect(detectSpotifyControl("oke kalo lagunya udh selesai stop aja ya")).toBeNull();
    expect(planSpotifyTurn("oke kalo lagunya udh selesai stop aja ya", new Set())).toBe("sleep-timer");
    expect(planSpotifyTurn("oke kalo lagunya udh selesai stop aja ya", new Set(["spotify_sleep_timer"]))).toBe("none");
  });

  it("keeps an explicit stop as a control and dedupes a control the model already ran", () => {
    expect(planSpotifyTurn("stop lagunya sekarang", new Set())).toBe("control");
    expect(planSpotifyTurn("stop lagunya sekarang", new Set(["spotify_pause"]))).toBe("none");
    expect(planSpotifyTurn("lanjut lagu", new Set(["spotify_next"]))).toBe("none");
  });

  it("never reads prose as a playback command (automation prompt containing SKIP)", () => {
    // live bug: a weather automation prompt ending "balas tepat: SKIP" matched
    // NEXT_RE and really skipped the owner's track.
    const prompt = "Cek cuaca. Kalau ada tanda hujan kirim pesan singkat, kalau kering balas tepat: SKIP";
    expect(isPlaybackCommand(prompt)).toBe(false);
    expect(detectSpotifyControl(prompt)).toBeNull();
    expect(planSpotifyTurn(prompt, new Set())).toBe("play"); // play-fallback only; agent skips it on headless turns
    // real commands keep working
    for (const [cmd, action] of [["skip", "next"], ["skip lagunya", "next"], ["next", "next"], ["pause dong", "pause"], ["oke stop", "pause"], ["volume 40", "volume"], ["tolong kecilin suara", "volume"], ["stop lagunya sekarang", "pause"]] as const) {
      expect(isPlaybackCommand(cmd), cmd).toBe(true);
      expect(detectSpotifyControl(cmd)?.action, cmd).toBe(action);
    }
    for (const prose of ["aku skip dulu ya guys, lanjut besok", "lanjut", "apa kabar?"]) {
      expect(detectSpotifyControl(prose), prose).toBeNull();
    }
  });

  it("resolves 'lagu favoritku' from the persona fact instead of searching the phrase", () => {
    expect(resolveFavoriteQuery("lagu favoritku dari m2m", "The Day You Went Away (M2M)", "M2M"))
      .toBe("The Day You Went Away M2M");
    expect(resolveFavoriteQuery("The Day You Went Away M2M", null, null)).toBe("The Day You Went Away M2M");
  });
});

describe("mood tone (no fabricated 'kemarin berat')", () => {
  it("treats a tie as neutral and only negative>positive as negative", () => {
    expect(moodTone([{ mood: "good" }, { mood: "tired" }])).toBe("neutral");
    expect(moodTone([{ mood: "tired" }, { mood: "tired" }, { mood: "good" }])).toBe("negative");
    expect(moodTone([{ mood: "good" }, { mood: "great" }])).toBe("positive");
    expect(moodTone([])).toBe("neutral");
  });
});

describe("notification hygiene", () => {
  it("keeps small-talk out of topics/highlights", () => {
    for (const f of ["alooo beb", "halo beb", "wkwk", "pagi beb"]) expect(isFillerLine(f)).toBe(true);
    expect(isFillerLine("justru kalo turun hujan malah seneng")).toBe(false);
  });

  it("honours the automation SKIP sentinel", () => {
    expect(isSilentAutomationReply("SKIP")).toBe(true);
    expect(isSilentAutomationReply("skip.")).toBe(true);
    expect(isSilentAutomationReply("Hujan jam 3, bawa payung ya")).toBe(false);
  });
});

describe("time keys are WIB, not server/UTC", () => {
  it("rolls the day and the daily rotation at WIB midnight", () => {
    expect(wibDay(t("2026-09-17T16:59:59Z"))).toBe("2026-09-17"); // 23:59 WIB
    expect(wibDay(t("2026-09-17T17:00:00Z"))).toBe("2026-09-18"); // 00:00 WIB
    expect(wibDayIndex(t("2026-09-17T16:59:59Z"))).not.toBe(wibDayIndex(t("2026-09-17T17:00:00Z")));
    expect(wibDayIndex(t("2026-09-17T17:00:00Z"))).toBe(wibDayIndex(t("2026-09-17T23:00:00Z")));
  });

  it("schedules daily automations at the WIB wall clock", () => {
    expect(clockLabel(wibDailyNext(7, 0, t("2026-09-17T18:00:00Z")))).toBe("07:00"); // 01:00 WIB → same day
    expect(wibDay(wibDailyNext(7, 0, t("2026-09-17T18:00:00Z")))).toBe("2026-09-18");
    expect(clockLabel(wibDailyNext(7, 0, t("2026-09-17T01:00:00Z")))).toBe("07:00"); // 08:00 WIB → next day
  });

  it("formats clocks 24-hour (no '06:00 AM')", () => {
    expect(clockLabel(t("2026-09-17T23:00:00Z"))).toBe("06:00"); // 06:00 WIB
    expect(clockLabel(t("2026-09-17T13:00:00Z"))).toBe("20:00"); // 20:00 WIB
  });
});

describe("place coordinates", () => {
  it("extracts coords from prose and rejects out-of-range pairs", () => {
    expect(parseLatLonAnywhere("Lake Home, Serpong (koordinat -6.378806,106.712563)"))
      .toEqual({ lat: -6.378806, lon: 106.712563 });
    expect(parseLatLonAnywhere("2026, 17")).toBeNull();
    expect(parseLatLonAnywhere("Jakarta")).toBeNull();
  });
});
