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
import { summarizeToolResults, userAskedForList } from "./agent";
import { reminderMessage, isTerseReminder, hasOwnCloser } from "./reminderMessage";

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

describe("verbatim list fast-path gate (no hijacked replies)", () => {
  it("only lets a personal list REPLACE the reply when the user asked for it", () => {
    // live bug: "ingetin aku makan siang jam 12" made the model call reminders_list
    // for context and the user got a reminder LIST instead of a confirmation
    expect(userAskedForList("reminders_list", "ingetin aku makan siang ya nanti jam 12")).toBe(false);
    expect(userAskedForList("reminders_list", "bikin reminder jam 7 pagi")).toBe(false);
    expect(userAskedForList("reminders_list", "halo")).toBe(false);
    expect(userAskedForList("list_tasks", "tambah tugas beli susu")).toBe(false);
    expect(userAskedForList("list_notes", "hapus catatan lama")).toBe(false);
    // a real list ask still takes the fast-path
    expect(userAskedForList("reminders_list", "reminder kamu apa aja?")).toBe(true);
    expect(userAskedForList("reminders_list", "ingetin aku, reminder apa aja yang aktif?")).toBe(true);
    expect(userAskedForList("list_tasks", "tugas aku apa aja?")).toBe(true);
    expect(userAskedForList("hotel_search", "cari hotel di bandung")).toBe(true);
    // work-product tools always win — their output IS the deliverable
    expect(userAskedForList("recon_subdomains", "halo")).toBe(true);
    expect(userAskedForList("suite_hunt", "coba lakukan full pentest di https://lab.example/index.html")).toBe(true);
    expect(userAskedForList("poc_verify", "verifikasi temuan ini")).toBe(true);
  });

  it("pentest CONTEXT lookups must not hijack a request to actually test", () => {
    // live bug: "coba lakukan full pentest di <lab>" → the agent called hunt_log
    // for context and the reply became a raw hunt-log dump of OTHER programs.
    const pentestAsk = "mia coba lakukan full pentest di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/index.html";
    expect(userAskedForList("hunt_log", pentestAsk)).toBe(false);
    expect(userAskedForList("engagement_targets", pentestAsk)).toBe(false);
    expect(userAskedForList("finding_list", "scan target ini")).toBe(false);
    expect(userAskedForList("http_history", "uji endpoint ini")).toBe(false);
    expect(userAskedForList("recon_list", "lanjut uji host itu ya")).toBe(false);
    expect(userAskedForList("csp_audit", pentestAsk)).toBe(false);
    expect(userAskedForList("cors_audit", pentestAsk)).toBe(false);
    // ...but "cek" IS an explicit list ask, so that still wins
    expect(userAskedForList("recon_list", "cek host itu")).toBe(true);
    expect(userAskedForList("csp_audit", "cek CSP situs itu")).toBe(true);
    // asking for those lists explicitly still yields the raw output
    expect(userAskedForList("hunt_log", "hunt log-ku apa aja?")).toBe(true);
    expect(userAskedForList("engagement_targets", "target yang harus kutes apa aja?")).toBe(true);
    expect(userAskedForList("finding_list", "temuan apa aja yang sudah ada?")).toBe(true);
  });
});

describe("reminder push formatting (single coherent line)", () => {
  it("uses a complete sentence as-is — no template, no extra supportive sentence", () => {
    // live oddity: "…Jangan skip ya 😄 · pukul 12:12" followed by
    // "Pelan-pelan aja, aku di sini" read like a non-sequitur.
    const out = reminderMessage("Mas Naufal, udah makan siang belum? Jangan skip ya 😄", "12:12");
    expect(out).toBe("Mas Naufal, udah makan siang belum? Jangan skip ya 😄 · pukul 12:12");
    expect(out.split("\n")).toHaveLength(1);
    expect(out).not.toMatch(/Pelan-pelan|Semangat|Jangan sampai kelewat/);
    expect(out).not.toContain("🌸"); // the channel wrapper carries the single flower
    for (const full of [
      "Bangun tidur Mas Naufal! ☀️🌸",
      "Selamat pagi, saatnya melek ya Mas Naufal ☀️",
      "Isi perut dulu ya, nanti aku temenin makan 😄",
      "jangan lupa minum air",
    ]) {
      expect(reminderMessage(full, "06:00").startsWith(full.replace(/🌸\s*$/, "").trim().slice(0, 12))).toBe(true);
      expect(reminderMessage(full, "06:00")).not.toMatch(/saatnya (Bangun|jangan)/);
    }
  });

  it("templates only a terse nudge, always with a closer", () => {
    expect(isTerseReminder("makan")).toBe(true);
    expect(isTerseReminder("minum air")).toBe(true);
    expect(isTerseReminder("Mas Naufal, udah makan siang belum?")).toBe(false);
    expect(hasOwnCloser("makan")).toBe(false);
    expect(hasOwnCloser("Beb, makan 🌸")).toBe(true);
    for (let i = 0; i < 20; i++) {
      const out = reminderMessage("makan", "12:00");
      expect(out).not.toContain("makan makan");
      expect(out.split("\n")).toHaveLength(1);
    }
  });
});

describe("empty-answer digest (never a dead-end after work ran)", () => {
  it("digests the last tool results instead of returning nothing", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "200 OK {\"nama\":\"Bambang\"}" },
    ] as never;
    const out = summarizeToolResults(messages);
    expect(out).toContain("http_request");
    expect(out).toContain("Bambang");
    expect(out).toMatch(/lanjut/); // tells the user how to continue
  });

  it("skips placeholder results and returns empty when there is nothing real", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Not selected: the user did not approve this action in this batch." },
    ] as never;
    expect(summarizeToolResults(messages)).toBe("");
  });
});
