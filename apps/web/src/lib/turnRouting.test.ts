// Turn-level regression locks for the bugs found from live pushes (2026-09-17).
//
// These assert the DECISIONS, not the network: the Spotify double-play, the
// fabricated mood claim, the filler "topic", the 12-hour clock and the UTC day
// key were all pure-logic bugs, so they can be locked here (fast, no network).

import { describe, expect, it } from "vitest";
import { metaProseNote } from "./metaProse";

describe("metaProseNote (stage-direction register leak)", () => {
  it("catches the live 3:17 PM stage-direction prose", () => {
    const text = "Laporan PDF yang dicetak sekarang berisi temuan yang sudah ada. Beri tahu Mas Naufal PDF sudah ada di folder laporan.";
    expect(metaProseNote(text)).not.toBe("");
  });
  it("catches generic addressee variants", () => {
    expect(metaProseNote("bilang owner kalau selesai")).not.toBe("");
    expect(metaProseNote("Kasih tahu Mas Naufal laporannya jadi")).not.toBe("");
  });
  it("never flags normal user-facing sentences", () => {
    expect(metaProseNote("Mas Naufal, laporannya sudah ada di folder ya 🌸")).toBe("");
    expect(metaProseNote("Kabari ya kalau mau kulanjutkan")).toBe("");
    expect(metaProseNote("Beri tahu aku kalau butuh diulang")).toBe("");
    expect(metaProseNote("")).toBe("");
  });
});

import { planSpotifyTurn, detectSpotifyAfterTrack, detectSpotifyControl, isPlaybackCommand } from "./spotifyIntent";
import { moodTone } from "./mood";
import { isFillerLine } from "./memoryNoise";
import { clockLabel, wibDay, wibDayIndex, wibDailyNext } from "./time";
import { isSilentAutomationReply } from "./automationRunner";
import { parseLatLonAnywhere } from "./geo";
import { resolveFavoriteQuery } from "./spotify";
import { isEffectivelyEmpty, looksLikeMarkdownList, stripToolCallProse, summarizeToolResults, userAskedForList, toolRunClaimSuffix, toolResultExecuted, toolActuallyRan, composeBuildClaimSuffix, SLIM_SYSTEM_PROMPT, buildSlimSystemPrompt, buildSystemPrompt, toolsForUrl } from "./agent";
import { reminderMessage, isTerseReminder, hasOwnCloser } from "./reminderMessage";
import { scrubToolMarkup } from "../channels/replyChunk";

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
    // security WORK tools are ask-gated too: mid-flow their output is context,
    // not the answer (so a full pentest can chain inside one turn).
    expect(userAskedForList("recon_subdomains", "halo")).toBe(false);
    expect(userAskedForList("suite_hunt", "coba lakukan full pentest di https://lab.example/index.html")).toBe(false);
    expect(userAskedForList("poc_verify", "verifikasi temuan ini")).toBe(false);
    // ...but an explicit ask still shows the raw result
    expect(userAskedForList("recon_subdomains", "cek subdomain target ini")).toBe(true);
    expect(userAskedForList("poc_verify", "lihat hasil poc_verify-nya")).toBe(true);
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
    expect(userAskedForList("finding_list", "temuan apa aja yang sudah ada?")).toBe(true); // via "apa aja"
    // ...but merely MENTIONING findings is not a list ask (live bug: "3 temuan
    // paling penting + ajakan baca PDF" got hijacked by the raw finding list).
    expect(userAskedForList("finding_list", "tulis pesan Discord-nya: 3 temuan paling penting + ajakan baca PDF")).toBe(false);
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

describe("markdown lists survive the mood reflow", () => {
  it("detects real bullet and numbered lists", () => {
    expect(looksLikeMarkdownList("1. **CRITICAL 9.8** `GET /x`\n2. **HIGH 7.5** `GET /y`")).toBe(true);
    expect(looksLikeMarkdownList("- item satu\n- item dua")).toBe(true);
    expect(looksLikeMarkdownList("Nih ringkasannya: dua temuan penting, yang pertama SQLi dan yang kedua XSS.")).toBe(false);
    expect(looksLikeMarkdownList("Satu temuan saja: SQLi di /api/cari-berita.")).toBe(false);
  });
});

describe("outbound scrub keeps list structure", () => {
  it("does not flatten blank-line-separated list items into one paragraph", () => {
    const reply = "Temuan portal Kohona:\n\n1. CRITICAL 9.8 /api/cari-berita — SQLi\n\n2. HIGH 7.5 /api/dokumen — BAC";
    const out = scrubToolMarkup(reply);
    expect(out.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("\n2.");
  });

  it("still tidies double spaces and tag-removal gaps", () => {
    expect(scrubToolMarkup("a  b")).toBe("a b");
    expect(scrubToolMarkup("x <invoke name=\"t\"></invoke> y")).toBe("x y");
  });
});

describe("markup scraps never reach the chat", () => {
  it("strips the DSML leak and the leftover scraps it leaves behind", () => {
    const leaked = ["<" + '｜｜DSML｜｜' + " calls>", "<" + '｜｜DSML｜｜' + ' invoke name="http_request">', "<" + '｜｜DSML｜｜' + ' parameter name="url">https://x', "</" + '｜｜DSML｜｜' + " invoke>", "</" + '｜｜DSML｜｜' + " calls>"].join("\n");
    const out = stripToolCallProse(leaked);
    expect(out).not.toMatch(/DSML/);
    expect(out.trimStart().startsWith("<")).toBe(false);
    expect(isEffectivelyEmpty(out)).toBe(true);
  });

  it("keeps real prose that merely sits next to markup", () => {
    const text = "Halo beb 🌸 " + "<" + '｜｜DSML｜｜' + " calls>";
    const out = stripToolCallProse(text);
    expect(out).toContain("Halo beb");
  });
});

describe("tool-run claim honesty (narration must match execution records)", () => {
  const ran = (name: string, content: string) => [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content },
  ] as never;

  it("flags a claimed-but-never-run tool (live 2026-09-21: 'kuuji pakai http_request' while only recon ran)", () => {
    const messages = ran("recon_subdomains", "3 subdomain ditemukan: api, www, dev");
    const text = "Aku sudah cek subdomain-nya, lalu kuuji pakai http_request ke endpoint API.";
    const out = toolRunClaimSuffix(messages, text);
    expect(out).not.toBe("");
    expect(out).toContain("http_request");
    expect(out).not.toContain("recon_subdomains"); // only the fabricated one is flagged
  });

  it("flags claims whose tool result was a refusal, not an execution", () => {
    // batch "Not selected"
    const refused = ran("http_request", "Not selected: the user did not approve this action in this batch.");
    expect(toolRunClaimSuffix(refused, "kuuji pakai http_request ke /api/dokumen")).not.toBe("");
    // delivery guard
    const undelivered = ran("exploit_chain", 'Error: tool "exploit_chain" is not available on this provider (tool budget).');
    expect(toolRunClaimSuffix(undelivered, "hasil dari exploit_chain menunjukkan 4 chain jalan")).not.toBe("");
    // headless auto-decline
    const headless = ran("http_request", "Auto-declined (headless turn).");
    expect(toolRunClaimSuffix(headless, "kueksekusi http_request dan berhasil")).not.toBe("");
  });

  it("is silent when the tool actually executed this turn", () => {
    for (const text of [
      "Kuuji pakai http_request ke /api/dokumen, hasilnya 200.",
      "Hasil dari recon_subdomains menampilkan 3 subdomain.",
      "poc_verify menunjukkan 3/3 PASS pada temuan itu.",
    ]) {
      const names = ["http_request", "recon_subdomains", "poc_verify"];
      const target = names.find((n) => text.includes(n))!;
      expect(toolRunClaimSuffix(ran(target, "OK 200"), text), text).toBe("");
    }
  });

  it("is silent on future/conditional/plan mentions (not claims of execution)", () => {
    const empty: never[] = [];
    expect(toolRunClaimSuffix(empty, "Nanti kupakai http_request kalau lanjut")).toBe("");
    expect(toolRunClaimSuffix(empty, "Seharusnya pakai poc_verify untuk bukti")).toBe("");
    expect(toolRunClaimSuffix(empty, "Kalau mau, aku bisa pakai http_request")).toBe("");
    expect(toolRunClaimSuffix(empty, "Saranku pakai web_search dulu")).toBe("");
  });

  it("is silent when the reply already admits non-execution", () => {
    const empty: never[] = [];
    expect(toolRunClaimSuffix(empty, "Belum sempat kupakai http_request, maaf")).toBe("");
    expect(toolRunClaimSuffix(empty, "Gagal kupakai poc_verify — errornya scope")).toBe("");
  });

  it("is silent for deterministically-executed tools (post-processors run outside the loop)", () => {
    const empty: never[] = [];
    expect(toolRunClaimSuffix(empty, "remind_me sudah kujalankan, jam 7 kubangunkan ya")).toBe("");
    expect(toolRunClaimSuffix(empty, "spotify_play langsung kupakai untuk lagunya")).toBe("");
    expect(toolRunClaimSuffix(empty, "report_pdf kuproses dan hasilnya sudah jadi")).toBe("");
    expect(toolRunClaimSuffix(empty, "mood_log kupakai untuk mencatat perasaanmu")).toBe("");
  });

  it("lists multiple fabricated claims, capped at three", () => {
    const text = "Kuuji pakai http_request, lalu poc_verify, terus web_search, dan akhirnya recon_subdomains berhasil.";
    const out = toolRunClaimSuffix([], text);
    expect(out).toContain("http_request");
    expect(out).toContain("poc_verify");
    expect(out).toContain("web_search");
    const listed = out.match(/http_request|poc_verify|web_search/g) ?? [];
    expect(listed.length).toBeLessThanOrEqual(3);
  });
});

describe("compose/build honesty (verdicts must never invert or fabricate)", () => {
  const ran = (name: string, content: string) => [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content },
  ] as never;

  it("flags a fabricated artifact path with no build (live probe 2026-09-22)", () => {
    const out = composeBuildClaimSuffix([], "Artefaknya sudah kubuat di .data/users/kamu/exploits/F-abc123-exploit.mjs — tinggal jalankan pakai node ya.");
    expect(out).not.toBe("");
    expect(out).toContain("exploit_build");
  });

  it("flags verdict inversion over a PUTUS compose", () => {
    const messages = ran("vuln_compose", "⛓️ VULN COMPOSE — lab.tld\n⚠️ VULN COMPOSE PUTUS DI HOP 1 — tidak ada temuan komposit yang dibuat.");
    const out = composeBuildClaimSuffix(messages, "Chain-nya terbukti penuh, semua hop tersambung dengan sempurna.");
    expect(out).not.toBe("");
    expect(out).toContain("vuln_compose");
  });

  it("flags verdict inversion over a failed build", () => {
    const messages = ran("exploit_build", "⛔ exploit_build tidak dibuat — finding F-x tanpa evidence/steps (belum proven).");
    const out = composeBuildClaimSuffix(messages, "Exploitnya sudah kubuat, file-nya ada di folder exploits.");
    expect(out).not.toBe("");
    expect(out).toContain("exploit_build");
  });

  it("flags proof narrated with no compose anywhere", () => {
    const out = composeBuildClaimSuffix([], "Rantai E2E-nya terbukti berhasil, semua hop valid.");
    expect(out).not.toBe("");
    expect(out).toContain("vuln_compose");
  });

  it("is silent when verdicts genuinely prove", () => {
    const comp = ran("vuln_compose", "✅ CHAIN TERBUKTI PENUH — temuan komposit critical dicatat");
    expect(composeBuildClaimSuffix(comp, "Chain terbukti penuh, temuan komposit sudah kucatat.")).toBe("");
    const build = ran("exploit_build", "📄 Artefak exploit dibuat: /x/F-a-exploit.mjs");
    expect(composeBuildClaimSuffix(build, "Artefaknya sudah kubuat di F-a-exploit.mjs, jalankan pakai node.")).toBe("");
  });

  it("is silent when the reply admits the gap", () => {
    const comp = ran("vuln_compose", "⚠️ VULN COMPOSE PUTUS DI HOP 2 — tidak ada temuan komposit yang dibuat.");
    expect(composeBuildClaimSuffix(comp, "Chain-nya putus di hop 2, belum terbukti — mau aku perbaiki?")).toBe("");
    expect(composeBuildClaimSuffix([], "Artefaknya belum ada — bilang saja kalau mau kubuatkan.")).toBe("");
  });

  it("is silent on unrelated prose", () => {
    expect(composeBuildClaimSuffix([], "Halo Mas Naufal, harimu gimana? 🌸")).toBe("");
    expect(composeBuildClaimSuffix([], "Nanti kalau ada temuan baru aku compose.")).toBe("");
  });
});

describe("tool result executed gate (refusals are not executions)", () => {
  it("rejects every placeholder/refusal shape", () => {
    expect(toolResultExecuted("Not selected: the user did not approve this action in this batch.")).toBe(false);
    expect(toolResultExecuted("Not executed (deferred).")).toBe(false);
    expect(toolResultExecuted("Auto-declined (headless turn).")).toBe(false);
    expect(toolResultExecuted('Error: tool "exploit_chain" is not available on this provider (tool budget).')).toBe(false);
    expect(toolResultExecuted("refused to execute (scope).")).toBe(false);
    expect(toolResultExecuted("")).toBe(false);
  });

  it("accepts real outputs, including honest tool errors", () => {
    expect(toolResultExecuted("200 OK {\"nama\":\"Bambang\"}")).toBe(true);
    expect(toolResultExecuted("Error: gagal menjalankan nuclei (binary not found)")).toBe(true); // real attempt, real error
  });

  it("toolActuallyRan only when a non-refused result exists", () => {
    const real = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "200 OK" },
    ] as never;
    expect(toolActuallyRan(real, "http_request")).toBe(true);
    const refused = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Not selected: ..." },
    ] as never;
    expect(toolActuallyRan(refused, "http_request")).toBe(false);
  });
});

describe("slim prompt for small providers (audit 2026-09-23)", () => {
  const R9 = "http://127.0.0.1:20128/v1/chat/completions";
  it("stays under 45% of the full prompt", () => {
    const full = buildSystemPrompt("u", "discord").length;
    const slim = buildSlimSystemPrompt("u", "discord", R9).length;
    expect(slim).toBeLessThan(full * 0.45);
  });
  it("keeps identity + scope + confirm + honesty + sweep essentials", () => {
    for (const needle of [
      "she/her", "SCOPE (pentest", "CONFIRM:", "HONESTY (hard):",
      "SWEEP:", "FINDING RULES:",
    ]) expect(SLIM_SYSTEM_PROMPT).toContain(needle);
    // Dynamic delivered-tool list lives in the builder, not the const.
    expect(buildSlimSystemPrompt("u", "discord", R9)).toContain("You have tools (ONLY these");
  });
  it("every registered tool named in slim is delivered in the 9router window", async () => {
    const { getTOOLS } = await import("./tools");
    const delivered = new Set(toolsForUrl(R9).map((t) => t.function.name));
    const names = getTOOLS().map((t) => t.function.name);
    expect(names.length).toBeGreaterThan(100);
    for (const n of names) {
      const quoted = SLIM_SYSTEM_PROMPT.includes(`\`${n}\``) || SLIM_SYSTEM_PROMPT.includes(`'${n}'`);
      if (quoted) expect(delivered.has(n), n).toBe(true);
    }
  });
  it("dynamic tool list equals the delivered set exactly", () => {
    const delivered = toolsForUrl(R9).map((t) => t.function.name);
    const built = buildSlimSystemPrompt("u", "discord", R9);
    const m = /You have tools \(ONLY these[^:]*: ([a-z0-9_, ]+)\./.exec(built);
    expect(m, "dynamic list present").toBeTruthy();
    expect(m![1].split(", ").sort()).toEqual([...delivered].sort());
  });
});
