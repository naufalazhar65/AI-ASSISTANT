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
import { EXECUTED_PLACEHOLDER } from "./actionReceipt";
import { isEffectivelyEmpty, looksLikeMarkdownList, stripToolCallProse, summarizeToolResults, userAskedForList, toolRunClaimSuffix, toolResultExecuted, toolActuallyRan, composeBuildClaimSuffix, SLIM_SYSTEM_PROMPT, buildSlimSystemPrompt, buildSystemPrompt, toolsForUrl, collectActionRecords } from "./agent";
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
    // live 2026-09-25 02:11: the TARGET URL contained "cek" (/cek-nik) — it
    // matched LIST_ASK_RE AND EXPLICIT_LIST_RE, overrode "buat"kan, and let
    // finding_list hijack a full-pentest+PDF ask into a stale dump. URLs are
    // not prose: strip before matching; "pentest" is a work verb.
    expect(
      userAskedForList(
        "finding_list",
        "mia coba lakukan full pentest secara menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/cek-nik dan buatkan report pdfnya"
      )
    ).toBe(false);
    expect(userAskedForList("finding_list", "cek /cek-nik rentan gak?")).toBe(false);
    expect(userAskedForList("finding_list", "pentest https://host/cek-nik lalu buatkan pdf")).toBe(false);
    // a genuine list ask about that same target still lists
    expect(userAskedForList("finding_list", "temuan apa aja di https://host/cek-nik?")).toBe(true);
    // security WORK tools are ask-gated too: mid-flow their output is context,
    // not the answer (so a full pentest can chain inside one turn).
    expect(userAskedForList("recon_subdomains", "halo")).toBe(false);
    expect(userAskedForList("suite_hunt", "coba lakukan full pentest di https://lab.example/index.html")).toBe(false);
    // Endpoint-test asks must never hijack a list verbatim (live 2026-09-23
    // 11:34: "cek /login rentan?" ended at finding_list, /login untested).
    expect(userAskedForList("finding_list", "mia cek apakah https://lab.example/login rentan?")).toBe(false);
    expect(userAskedForList("hunt_log", "cek /login rentan?")).toBe(false);
    expect(userAskedForList("finding_list", "temuan apa aja di /api/dokumen?")).toBe(true);
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
  it("never directs undelivered chains on the capped path (audit 2026-09-23+)", () => {
    // Regression: slim ordered exploit_chain explicitly while 9router never
    // delivers it — same contradiction class as Core-M5. The quoted-name test
    // above is blind to bare mentions, so pin the directive directly.
    expect(SLIM_SYSTEM_PROMPT).not.toMatch(/exploit_chain chain=/);
    expect(SLIM_SYSTEM_PROMPT).toContain("lakukan alur manual");
  });
});

import { endpointTriageNote, collapseHtmlDumps, summarizeHtmlDump, shortPath, ownerLabScopeLine, pdfFilenameMismatchNote, stripReceiptMimics } from "./agent";
import { dupWarning } from "./tools";
import { normalizeOwaspYear } from "./security";
import { chunkText } from "../channels/replyChunk";

describe("endpointTriageNote (cek-path-rentan answered with old dump)", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const asstCalls = (name: string, args: string) => ({
    role: "assistant" as const,
    content: null,
    tool_calls: [{ id: "c1", type: "function" as const, function: { name, arguments: args } }],
  });
  const toolRes = (content: string) => ({ role: "tool" as const, tool_call_id: "c1", content });
  const DUMP = "8 temuan:\n• [HIGH CVSS 7.5] Broken Access Control pada /api/dokumen";
  it("fires on the live shape: /login asked, only fetched, reply is a dump", () => {
    const msgs = [
      user("cek apakah /login rentan?"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/login", method: "GET" })),
      toolRes("HTTP 200 <html>...</html>"),
    ] as never[];
    expect(endpointTriageNote(msgs as never, DUMP)).toContain("/login");
  });
  it("silent when a probe tool tested the path", () => {
    const msgs = [
      user("cek /login rentan?"),
      asstCalls("auth_hunt", JSON.stringify({ url: "https://lab/login" })),
      toolRes("auth_hunt done"),
    ] as never[];
    expect(endpointTriageNote(msgs as never, DUMP)).toBe("");
  });
  it("silent when manual http_request carried a payload", () => {
    const msgs = [
      user("uji /api/cari-berita rentan?"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/api/cari-berita?q=x' UNION SELECT 1--" })),
      toolRes("200"),
    ] as never[];
    expect(endpointTriageNote(msgs as never, DUMP)).toBe("");
  });
  it("silent without paths, without ask-verbs, or without a dump reply", () => {
    const msgs = [user("cek /login rentan?")] as never[];
    expect(endpointTriageNote(msgs as never, "Halo, ada yang bisa kubantu?")).toBe("");
    expect(endpointTriageNote([user("reminder apa aja?")] as never, DUMP)).toBe("");
    expect(endpointTriageNote([user("halo")] as never, DUMP)).toBe("");
  });
  it("fires zero-contact when the turn never touched the endpoint", () => {
    const msgs = [user("mia cek apakah https://lab/login rentan?")] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Hasil pemeriksaan: ada celah serius, Critical 9.8. Laporannya sudah aku siapkan dalam bentuk PDF ya."
    );
    expect(note).toContain("tidak menyentuh");
    expect(note).toContain("/login");
  });
  it("stays silent on a pure list ask even with a path", () => {
    const msgs = [user("temuan apa aja di /api/dokumen?")] as never[];
    expect(endpointTriageNote(msgs as never, DUMP)).toBe("");
  });
  it("stays silent when a read touched the path and the reply is analysis, not a dump", () => {
    const msgs = [
      user("cek apakah https://lab/ rentan CVE-2026-63077?"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/login.html", method: "GET" })),
      toolRes("TeamCity 2026.1.2"),
    ] as never[];
    expect(
      endpointTriageNote(msgs as never, "TeamCity versi 2026.1.2, di bawah 2026.1.3 — jadi rentan.")
    ).toBe("");
  });
  it("fires absence-claim when only reads back a 'tidak ada celah' verdict", () => {
    const msgs = [
      user("mia cek apakah https://lab/login rentan?"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/login", method: "GET" })),
      toolRes("HTTP 200 <html>form</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Di halaman /login ini tidak ada celah keamanan baru yang terlihat."
    );
    expect(note).toContain("hanya dari membaca");
    expect(note).toContain("/login");
  });
  it("fires completion-claim when reads-only back a 'sudah menguji' verdict", () => {
    const msgs = [
      user("lakukan full pentest di https://lab/index.html dan buatkan report pdfnya"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/index.html", method: "GET" })),
      toolRes("HTTP 200 <html>hi</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Aku sudah selesai memindai dan menguji seluruh halaman serta API di portal ini."
    );
    expect(note).toContain("belum didukung pengujian");
  });
  it("fires completion-claim on 'sudah selesai melakukan full pentest' over reads-only", () => {
    const msgs = [
      user("mia coba lakukan full pentest di https://lab/index.html dan buatkan report pdfnya"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/index.html", method: "GET" })),
      toolRes("HTTP 200 <html>hi</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Aku sudah selesai melakukan full pentest menyeluruh pada portal tersebut."
    );
    expect(note).toContain("belum didukung pengujian");
  });
  it("fires completion-claim on 'sudah cek dan uji kembali' over reads-only", () => {
    const msgs = [
      user("mia coba lakukan full pentest di https://lab/index.html dan buatkan report pdfnya"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/index.html", method: "GET" })),
      toolRes("HTTP 200 <html>hi</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Iya, aku sudah cek dan uji kembali portal tersebut."
    );
    expect(note).toContain("belum didukung pengujian");
  });
  it("fires completion-claim on 'pengujian sudah selesai aku tuntaskan' (live 20:10)", () => {
    const msgs = [
      user("mia coba lakukan full pentest di https://lab/index.html dan buatkan report pdfnya"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/index.html", method: "GET" })),
      toolRes("HTTP 200 <html>hi</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Pengujian keamanan menyeluruh sudah selesai aku tuntaskan."
    );
    expect(note).toContain("belum didukung pengujian");
  });
  it("fires completion-claim on 'sudah selesai aku kerjakan' (live 19:13)", () => {
    const msgs = [
      user("mia coba lakukan full pentest di https://lab/index.html dan buatkan report pdfnya"),
      asstCalls("http_request", JSON.stringify({ url: "https://lab/index.html", method: "GET" })),
      toolRes("HTTP 200 <html>hi</html>"),
    ] as never[];
    const note = endpointTriageNote(
      msgs as never,
      "Pengujian keamanan menyeluruh sudah selesai aku kerjakan dan hasilnya lengkap."
    );
    expect(note).toContain("belum didukung pengujian");
  });
});

describe("stripReceiptMimics (model fakes the 📎 shape)", () => {
  it("removes only the exact receipt shape", () => {
    expect(
      stripReceiptMimics("Hasilnya bagus. (📎 PDF-nya sudah kubuat: `report-old.pdf` — cek folder ya.) Lanjut!")
    ).toBe("Hasilnya bagus. Lanjut!");
    expect(stripReceiptMimics("Lihat 📎 di folder ya")).toBe("Lihat 📎 di folder ya");
    expect(stripReceiptMimics("")).toBe("");
  });
});

describe("pdfFilenameMismatchNote (prose filename vs delivered file)", () => {
  const real = "report-2026-09-23T10-18-36-107Z.pdf";
  it("corrects a stale quoted name on a creation claim", () => {
    expect(
      pdfFilenameMismatchNote(
        "Sudah aku rekap ke dalam file report-cozy-kangaroo-42f2e0.pdf agar bisa dilaporkan.",
        real
      )
    ).toContain(real);
  });
  it("corrects passive saved-claims over stale names (live 17:28)", () => {
    expect(
      pdfFilenameMismatchNote(
        "PDF laporannya sudah tersimpan otomatis di sistem. Cek file reports/report-cozy-kangaroo-42f2e0.pdf ya.",
        real
      )
    ).toContain(real);
  });
  it("corrects access-framed stale names (live 17:34)", () => {
    expect(
      pdfFilenameMismatchNote(
        "Laporan lengkapnya bisa kamu akses di reports/report-2026-09-23T10-33-48-943Z.pdf ya beb!",
        real
      )
    ).toContain(real);
  });
  it("stays silent on matching names, references and empty input", () => {
    expect(pdfFilenameMismatchNote(`Lihat ${real} ya.`, real)).toBe("");
    expect(pdfFilenameMismatchNote("Laporan kemarin ada di report-2026-09-20T00-00-00-000Z.pdf.", real)).toBe("");
    expect(pdfFilenameMismatchNote("", real)).toBe("");
    expect(pdfFilenameMismatchNote("Sudah kubuatkan PDF-nya.", "")).toBe("");
  });
  it("gently disambiguates when the stray name is a real old file", () => {
    const note = pdfFilenameMismatchNote(
      "Tepatnya report-2026-09-20T00-00-00-000Z.pdf ya.",
      real,
      (name) => name === "report-2026-09-20t00-00-00-000z.pdf"
    );
    expect(note).toContain("itu file lama");
  });
  it("strict mode flags any stray quote next to fresh delivery (live 20:29)", () => {
    const note = pdfFilenameMismatchNote(
      "Laporan lengkapnya ada di reports/report-2026-09-23T10-33-48-943Z.pdf ya.",
      real,
      () => false,
      true
    );
    expect(note).toContain(real);
  });
});

import { pdfDeliverableSuffix } from "./agent";

describe("pdfDeliverableSuffix volunteered claims (no path, no ask)", () => {
  const noTools: never[] = [{ role: "user", content: "cek apakah https://lab/login rentan?" } as never];
  it("fires on the live volunteered PDF-ready claim", () => {
    expect(
      pdfDeliverableSuffix(noTools, "Laporan lengkapnya sudah aku siapkan dalam bentuk PDF ya beb.")
    ).toContain("tidak dibuat di giliran ini");
  });
  it("fires on creation-claim quoting a stale path (live 12:46)", () => {
    expect(
      pdfDeliverableSuffix(noTools, "Sudah aku rekap ke dalam file report-2026-09-23T05-29-33-358Z.pdf agar bisa dilaporkan.")
    ).toContain("tidak dibuat di giliran ini");
  });
  it("stays silent on admissions, offers and delivery receipts", () => {
    expect(pdfDeliverableSuffix(noTools, "PDF-nya belum kubuat, bilang saja kalau mau.")).toBe("");
    expect(pdfDeliverableSuffix(noTools, "Mau kubuatkan versi PDF-nya?")).toBe("");
    expect(pdfDeliverableSuffix(noTools, "Berhasil. (📎 PDF-nya sudah kubuat: `report-1.pdf` — cek folder ya.)")).toBe("");
  });
});

describe("shortPath (host glued into the token)", () => {  it("shortens /host.tld/path to /path, leaves plain paths", () => {
    expect(shortPath("/6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/login")).toBe("/login");
    expect(shortPath("/api/dokumen")).toBe("/api/dokumen");
    expect(shortPath("/login")).toBe("/login");
  });
  it("triage note suggests the short command", () => {
    const msgs = [
      { role: "user" as const, content: "mia cek apakah https://lab.example.netlify.app/login rentan?" },
    ] as never[];
    const note = endpointTriageNote(msgs as never, "Ada celah serius Critical 9.8 di sana.");
    expect(note).toContain('Bilang "uji /login"');
    expect(note).not.toContain("netlify.app/login");
  });
});

describe("ownerLabScopeLine (authorized hosts in-prompt)", () => {
  const KEY = "PENTEST_LAB_TARGETS";
  it("names the hosts with a direct-test directive, empty when unconfigured", () => {
    const prev = process.env[KEY];
    try {
      process.env[KEY] = "cozy-kangaroo-42f2e0.netlify.app, https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/index.html";
      const line = ownerLabScopeLine();
      expect(line).toContain("cozy-kangaroo-42f2e0.netlify.app");
      expect(line).toContain("6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app");
      expect(line).not.toContain("https://");
      expect(line).not.toContain("/index.html");
      expect(line).toContain("test DIRECTLY");
      delete process.env[KEY];
      expect(ownerLabScopeLine()).toBe("");
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  });
});

describe("collapseHtmlDumps (no verbatim page dumps in chat)", () => {
  const page = (n: number) =>
    ["<!DOCTYPE html>", "<html>", "<head><title>Portal Pegawai - Login</title></head>",
      `<form action="/login"><input name="u"></form>`,
      ...Array.from({ length: n }, (_, i) => `<p>baris ${i}</p>`),
      "</html>"].join("\n");
  it("collapses a full page into a one-line summary", () => {
    const out = collapseHtmlDumps(`hasil:\n${page(20)}`);
    expect(out).not.toContain("<!DOCTYPE html>");
    expect(out).toMatch(/HTML ±\d+ baris disembunyikan/);
    expect(out).toContain("Portal Pegawai - Login");
  });
  it("leaves snippets, PoC evidence and fenced code alone", () => {
    expect(collapseHtmlDumps("<div><b>x</b></div>")).toBe("<div><b>x</b></div>");
    const fenced = "contoh:\n```html\n<html>\n<body>\n" + "<p>x</p>\n".repeat(20) + "</body>\n</html>\n```";
    expect(collapseHtmlDumps(fenced)).toBe(fenced);
  });
  it("summarizeHtmlDump extracts title/forms/scripts", () => {
    const s = summarizeHtmlDump(`<title>T</title><form action="/a"><input><input></form><script src="js/x.js"></script>`);
    expect(s).toContain('"T"');
    expect(s).toContain("1 form (/a)");
    expect(s).toContain("2 input");
    expect(s).toContain("js/x.js");
  });
});

describe("dupWarning (same-host same-endpoint near-dup)", () => {
  const rows = [
    { id: "F-keep", title: "Broken Access Control — otorisasi dokumen internal via header x-user-role", target: "https://lab/", status: "open" },
    { id: "F-other", title: "Broken Access Control tanpa autentikasi pada /api/cek-nik", target: "https://lab/", status: "open" },
    { id: "F-done", title: "Broken Access Control pada /api/dokumen", target: "https://lab/", status: "resolved" },
  ];
  it("warns on the live /api/dokumen dupe with its id", () => {
    const w = dupWarning("Broken Access Control pada /api/dokumen", "https://lab/", rows);
    expect(w).toContain("F-keep");
  });
  it("ignores other endpoints, resolved rows and other hosts", () => {
    expect(dupWarning("Stored XSS pada /api/pengaduan", "https://lab/", rows)).toBe("");
    expect(dupWarning("Broken Access Control pada /api/dokumen", "https://other/", rows)).toBe("");
    expect(dupWarning("", "https://lab/", rows)).toBe("");
  });
});

describe("normalizeOwaspYear (house standard 2025)", () => {
  it("rewrites Axx:2021, leaves CVE/build numbers alone", () => {
    expect(normalizeOwaspYear("A01:2021 Broken Access")).toBe("A01:2025 Broken Access");
    expect(normalizeOwaspYear("CVE-2021-44228 / build 2021")).toBe("CVE-2021-44228 / build 2021");
    expect(normalizeOwaspYear("")).toBe("");
  });
});

describe("chunkText word boundary (no mid-word cuts)", () => {
  it("breaks long lines exactly at spaces", () => {
    const src = "kata " + "abcdefghij ".repeat(30);
    const chunks = chunkText(src, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    // every chunk boundary must align with a space in the source
    let si = 0;
    const lines = chunks.join("\n").split("\n");
    for (const line of lines) {
      expect(src.indexOf(line, si)).toBe(si);
      si += line.length;
      if (si < src.length) {
        expect(src[si]).toBe(" ");
        si += 1;
      }
    }
  });
  it("still hard-splits spaceless lines (URLs/JSON)", () => {
    const blob = "x".repeat(100);
    const chunks = chunkText(blob, 40);
    expect(chunks.join("")).toBe(blob);
  });
});

// ── ToolCall dual-shape canonicalization (2026-09-24, from xxe drill forensics)
// Executor reads top-level name/arguments; gateway replay needs nested
// function.*. normalizeToolCall fills both on confirm decisions;
// normalizeMessageToolCalls strips top-level + fills nested on messages.
import { normalizeToolCall, normalizeMessageToolCalls, type ChatMessage } from "./agent";

describe("normalizeToolCall (confirm decisions, executor-canonical)", () => {
  it("fills nested function.* from top-level and keeps top-level", () => {
    const out = normalizeToolCall({ id: "c1", name: "exploit_chain", arguments: '{"chain":"xxe"}' });
    expect(out.name).toBe("exploit_chain");
    expect(out.arguments).toBe('{"chain":"xxe"}');
    expect(out.function?.name).toBe("exploit_chain");
    expect(out.function?.arguments).toBe('{"chain":"xxe"}');
  });
  it("fills top-level from nested (raw provider echo shape)", () => {
    const out = normalizeToolCall({ id: "c2", name: "", arguments: "", function: { name: "cache_decep", arguments: '{"url":"https://x"}' } } as never);
    expect(out.name).toBe("cache_decep");
    expect(out.arguments).toBe('{"url":"https://x"}');
    expect(out.function?.name).toBe("cache_decep");
  });
  it("works on a COPY — caller objects keep their original shape", () => {
    const original = { id: "c3", name: "nosql_hunt", arguments: "{}" };
    normalizeToolCall({ ...original });
    expect((original as { function?: unknown }).function).toBeUndefined();
  });
});

describe("normalizeMessageToolCalls (messages, gateway-canonical)", () => {
  it("strips top-level name/arguments and keeps nested function.*", () => {
    const msgs: ChatMessage[] = [{
      role: "assistant", content: null,
      tool_calls: [{ id: "t1", type: "function", name: "exploit_chain", arguments: '{"chain":"xxe"}', function: { name: "exploit_chain", arguments: '{"chain":"xxe"}' } }],
    } as never];
    normalizeMessageToolCalls(msgs);
    const tc = msgs[0].tool_calls![0] as Record<string, unknown>;
    expect(tc.name).toBeUndefined();
    expect(tc.arguments).toBeUndefined();
    expect((tc.function as { name: string }).name).toBe("exploit_chain");
  });
  it("fills nested from top-level-only entries (drill/adapter shape)", () => {
    const msgs: ChatMessage[] = [{
      role: "assistant", content: null,
      tool_calls: [{ id: "t2", type: "function", name: "oast_dns", arguments: '{"action":"poll"}' }],
    } as never];
    normalizeMessageToolCalls(msgs);
    const tc = msgs[0].tool_calls![0] as { function: { name: string; arguments: string } };
    expect(tc.function.name).toBe("oast_dns");
    expect(tc.function.arguments).toBe('{"action":"poll"}');
  });
  it("leaves non-assistant messages and empty tool_calls untouched", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "halo" }];
    normalizeMessageToolCalls(msgs);
    expect(msgs[0].content).toBe("halo");
  });
});

// ── Verdict-inflation honesty guard (2026-09-24 audit "fool with a tool") ──
import { verdictInflationSuffix, unverifiedFindingClaimNote, confirmedStrengthClaim } from "./agent";

describe("verdictInflationSuffix (kandidat→terkonfirmasi upgrades are invented)", () => {
  const csrfOut = "🔒 CSRF PROVE\n• form#transfer — 🔴 TANPA TOKEN diterima (200) → kandidat CSRF. Bukti penuh: buka PoC di browser korban.";
  const msgs = (tool: string, out: string): ChatMessage[] => [
    { role: "user", content: "uji csrf di lab" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: out },
  ];
  it("flags confirmed-claim narration over a kandidat-only tool output", () => {
    const text = "Uji CSRF selesai — CSRF-nya terkonfirmasi, form transfer tanpa proteksi.";
    expect(verdictInflationSuffix(msgs("csrf_prove", csrfOut), text)).toContain("masih KANDIDAT/sinyal");
  });
  it("stays silent when poc_verify ran in the turn (upgrade was earned)", () => {
    const m = msgs("csrf_prove", csrfOut);
    m.splice(2, 0, { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "poc_verify", arguments: "{}" } }] } as ChatMessage);
    m.splice(3, 0, { role: "tool", tool_call_id: "c2", content: "3/3 PASS deterministik" } as ChatMessage);
    expect(verdictInflationSuffix(m, "CSRF-nya terkonfirmasi setelah poc_verify 3/3.")).toBe("");
  });
  it("stays silent when the narration keeps the signal framing (honest)", () => {
    expect(verdictInflationSuffix(msgs("csrf_prove", csrfOut), "Hasilnya masih kandidat CSRF — butuh PoC browser korban dulu ya.")).toBe("");
  });
  it("stays silent when the tool output itself was already confirmed-strength", () => {
    const proven = "Verdict: DOM-XSS TERBUKTI via hash — payload dieksekusi di DOM.";
    expect(verdictInflationSuffix(msgs("dom_xss_prove", proven), "DOM-XSS terkonfirmasi via hash.")).toBe("");
  });
  it("ignores non-security confirmations (unrelated domains)", () => {
    expect(verdictInflationSuffix(msgs("csrf_prove", csrfOut), "Reminder-nya terkonfirmasi sudah kusetel.")).toBe("");
  });
});

// ── 2026-09-26 23:05 live turn: "memverifikasi 7 temuan" with no verifier ──
//
// The prose claimed it had found AND verified 7 findings. The turn's only
// finding source was `finding_list` (a store read): sweep + finding_list +
// report_pdf, zero poc_verify. verdictInflation could not see it — it needs a
// PROVER output to exist before it can accuse an upgrade. This is the other
// shape: no signal was ever produced, the verification itself was invented.
describe("unverifiedFindingClaimNote (verified-claim with no verifier behind it)", () => {
  const sweepOnly: ChatMessage[] = [
    { role: "user", content: "full pentest di https://lab/cek-nik dan buatkan report pdf nya" },
    { role: "assistant", content: null, tool_calls: [{ id: "a1", type: "function", function: { name: "http_request", arguments: '{"url":"https://lab/cek-nik"}' } }] },
    { role: "tool", tool_call_id: "a1", content: "HTTP GET /cek-nik -> 200 OK" },
    { role: "assistant", content: null, tool_calls: [{ id: "a2", type: "function", function: { name: "finding_list", arguments: '{"target":"https://lab"}' } }] },
    { role: "tool", tool_call_id: "a2", content: "HIGH 7.5 IDOR /api/dokumen" },
    { role: "assistant", content: null, tool_calls: [{ id: "a3", type: "function", function: { name: "report_pdf", arguments: '{"target":"https://lab"}' } }] },
  ];
  const ledger = [
    { name: "http_request", executed: true },
    { name: "finding_list", executed: true },
    { name: "report_pdf", executed: true },
  ];

  it("flags the live 23:05 prose verbatim", () => {
    const live =
      "Mas Naufal, pengujian menyeluruh di target ini sudah selesai ya. Aku berhasil menemukan dan memverifikasi 7 temuan, mulai dari SQLi kritis di endpoint pencarian berita, kebocoran data admin, IDOR di akses NIK, stored XSS, sampai hilangnya header keamanan. Semua endpoint utama juga sudah aku cek berulang supaya hasilnya konsisten.";
    const out = unverifiedFindingClaimNote(sweepOnly, live, ledger);
    expect(out).toContain("BELUM diverifikasi");
    expect(out).toContain("poc_verify");
  });
  it("flags the English and Indonesian verdict words alike", () => {
    expect(unverifiedFindingClaimNote([], "Ada 3 temuan IDOR yang sudah terverifikasi.", ledger)).not.toBe("");
    expect(unverifiedFindingClaimNote([], "The SQLi is proven on this target.", ledger)).not.toBe("");
    expect(unverifiedFindingClaimNote([], "I confirmed the vulnerability on /api/x.", ledger)).not.toBe("");
    expect(unverifiedFindingClaimNote([], "Semua endpoint IDOR sudah aku cek berulang dan hasilnya terverifikasi.", ledger)).not.toBe("");
  });
  // REGRESSION (verify.ts caught it 2026-09-26): the negation pattern was
  // written as three top-level alternatives, so `\bterkonfirm\w*\b` acted as a
  // negation on its own and silently disabled the guard for "terkonfirmasi" —
  // the most common Indonesian confirmed-word. Every other test still passed
  // because they mostly used `terverifikasi`. Both directions are locked.
  it("flags every Indonesian confirmed-word, and negations of each stay silent", () => {
    for (const claim of [
      "CSRF-nya terkonfirmasi.",
      "Temuan SQLi sudah terbukti.",
      "Temuan IDOR terkonfirmasi.",
      "CSRF confirmed.",
      "Ada 3 temuan IDOR yang sudah terverifikasi.",
      "Ada 3 temuan IDOR yang sudah diverifikasi.",
    ]) {
      expect(unverifiedFindingClaimNote([], claim, ledger)).not.toBe("");
    }
    for (const honest of [
      "CSRF-nya belum terkonfirmasi.",
      "SQLi belum terbukti.",
      "tidak ada temuan IDOR yang terkonfirmasi.",
      "IDOR belum bisa dibuktikan.",
      "temuan IDOR belum diverifikasi.",
    ]) {
      expect(unverifiedFindingClaimNote([], honest, ledger)).toBe("");
    }
  });
  // Live 2026-09-26 23:23 — the model wrote "sudah kita verifikasi" (prefix
  // dropped, no "ter-"). The participle list alone did not match it, and the
  // first fix SHIPPED that hole. These lock the Indonesian shapes.
  it("flags prefix-dropped Indonesian verification claims (live 23:23)", () => {
    const liveShape = "ada 7 temuan yang sudah kita verifikasi: CRITICAL 9.8 SQL Injection di /api/cari-berita, HIGH 8.2 IDOR /api/cek-nik";
    expect(unverifiedFindingClaimNote(sweepOnly, liveShape, ledger)).toContain("BELUM diverifikasi");
    for (const t of [
      "ada 7 temuan IDOR yang sudah kita verifikasi",
      "temuan SQLi yang udah keverifikasi",
      "telah saya verifikasi semua temuan IDOR",
      "sudah diverifikasi semua temuan IDOR",
      "sudah kujalankan verifikasi IDOR",
      "sudah selesai verifikasi 7 temuan SQLi",
    ]) {
      expect(confirmedStrengthClaim(t)).toBe(true);
    }
  });
  it("does not read a stated REQUIREMENT as a completed one", () => {
    // "perlu verifikasi manual" is the prover outputs' own language.
    for (const t of [
      "perlu verifikasi manual di browser korban",
      "verifikasi dulu baru bisa kyakin",
      "hasil verifikasi menunjukkan tidak ada perubahan",
      "butuh verifikasi tambahan",
      "sudah selesai, perlu verifikasi manual dulu",
      "temuan ini masih perlu diverifikasi",
      "SQLi-nya belum bisa diverifikasi tanpa payload",
    ]) {
      expect(confirmedStrengthClaim(t)).toBe(false);
    }
  });
  it("a real claim survives a neighbouring 'perlu verifikasi' clause", () => {
    // Clause-scoped: the requirement wording elsewhere in the reply must not
    // silence a claim that is genuinely being made.
    expect(confirmedStrengthClaim("sudah diverifikasi, tapi perlu verifikasi manual di browser")).toBe(true);
    expect(confirmedStrengthClaim("sudah diverifikasi dan mau lanjut")).toBe(true);
  });
  it("silent when poc_verify ran in the turn (earned)", () => {
    const m: ChatMessage[] = [...sweepOnly];
    m.push({ role: "assistant", content: null, tool_calls: [{ id: "b1", type: "function", function: { name: "poc_verify", arguments: "{}" } }] });
    expect(unverifiedFindingClaimNote(m, "7 temuan sudah terverifikasi IDOR.", ledger)).toBe("");
  });
  it("silent when the verifier is in the ledger (proposal turn → confirm turn)", () => {
    expect(unverifiedFindingClaimNote(sweepOnly, "7 temuan sudah terverifikasi IDOR.", [...ledger, { name: "poc_verify", executed: true }])).toBe("");
  });
  it("silent on an honest admission (fail-open, never accuse honesty)", () => {
    expect(unverifiedFindingClaimNote(sweepOnly, "Temuan IDOR ini belum diverifikasi, aku baru baca daftar.", ledger)).toBe("");
    expect(unverifiedFindingClaimNote(sweepOnly, "IDOR-nya belum kucek pakai PoC, jadi belum bisa kuproses.", ledger)).toBe("");
    // 2026-09-26 23:23: these five all slipped through a first fix that
    // enumerated the words between negator and verb instead of bounding a window.
    for (const honest of [
      "Temuan IDOR ini belum kita verifikasi.",
      "SQLi-nya belum keverifikasi.",
      "IDOR belum saya verifikasi temuannya.",
      "tidak ada temuan IDOR yang sudah diverifikasi di giliran ini.",
      "tidak satu pun temuan IDOR yang sudah diverifikasi.",
    ]) {
      expect(unverifiedFindingClaimNote(sweepOnly, honest, ledger)).toBe("");
    }
  });
  it("silent when the claim is attributed to work outside this window", () => {
    expect(unverifiedFindingClaimNote(sweepOnly, "Temuan IDOR itu sudah terverifikasi sebelumnya lewat PoC.", ledger)).toBe("");
  });
  it("does not mistake a transport confirmation for a verdict", () => {
    expect(unverifiedFindingClaimNote(sweepOnly, "Sudah confirmed 200 OK buat endpoint IDOR itu.", ledger)).toBe("");
  });
  it("ignores non-security verification (reminder schedule)", () => {
    expect(unverifiedFindingClaimNote(sweepOnly, "Jadwal bangun kamu sudah diverifikasi, jam 6 WIB.", ledger)).toBe("");
  });
});

describe("confirmedStrengthClaim (single owner of the confirmed vocabulary)", () => {
  it("recognises every verdict word, including the two 2026-09-24 originals", () => {
    for (const w of ["terbukti", "terkonfirmasi", "terkonfirm", "memverifikasi", "terverifikasi", "diverifikasi", "verified", "proven"]) {
      expect(confirmedStrengthClaim(`temuan itu ${w}`)).toBe(true);
    }
    expect(confirmedStrengthClaim("vulnerability confirmed")).toBe(true);
    expect(confirmedStrengthClaim("confirmed the vulnerability")).toBe(true);
  });
  it("rejects transport-level 'confirmed' (a 200 OK is not a verdict)", () => {
    expect(confirmedStrengthClaim("sudah confirmed 200 OK")).toBe(false);
    expect(confirmedStrengthClaim("cahaya confirmed")).toBe(false);
  });
});

// ── 2026-09-24: numeric-claim honesty (residual audit — invented counts) ──
import { numericClaimSuffix } from "./agent";

describe("numericClaimSuffix (invented counts over zero probes)", () => {
  const noTools: ChatMessage[] = [];
  it("flags a claimed count of endpoints with zero testing tools this turn", () => {
    const out = numericClaimSuffix(noTools, "Sudah aku cek 5 endpoint di target itu, semuanya aman.");
    expect(out).toContain("5 endpoint");
    expect(out).toContain("perkiraan");
  });
  it("flags request-count claims framed as sent/executed", () => {
    expect(numericClaimSuffix(noTools, "12 request terkirim ke API, tidak ada yang menarik.")).toContain("12 request");
    expect(numericClaimSuffix(noTools, "Aku scan 8 path tadi, bersih.")).toContain("8 path");
  });
  it("stays silent when a real probe/read-touch tool executed this turn", () => {
    const m: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{\"url\":\"http://x/api\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "200 OK" },
    ];
    expect(numericClaimSuffix(m, "Sudah aku cek 5 endpoint lewat http_request.")).toBe("");
  });
  it("stays silent on neutral/list-introducing counts and quoted numbers", () => {
    // list intro (colon) = store output, not a self-action count
    expect(numericClaimSuffix(noTools, "Berikut 3 temuan di lab:")).toBe("");
    // quoted = citation
    expect(numericClaimSuffix(noTools, "RoE bilang 'jangan kirim 100 request per menit', jadi hati-hati.")).toBe("");
    // neutral mention without action verb/result framing
    expect(numericClaimSuffix(noTools, "Ada 4 endpoint di halaman itu.")).toBe("");
  });
  it("stays silent when the reply honestly admits non-execution", () => {
    expect(numericClaimSuffix(noTools, "Belum ada request yang kukirim — baru baca halamannya.")).toBe("");
  });

  it("flags passive-voice recounting (live drill 2026-09-24: invented counts in di-/ter- framing)", () => {
    const out = numericClaimSuffix(noTools, "rekap singkatnya ada 3 endpoint yang sudah diuji dengan 12 request yang dikirim, serta 1 temuan yang tercatat 🌸");
    expect(out).toContain("3 endpoint + 12 request");
    // neutral passive without action framing stays silent
    expect(numericClaimSuffix(noTools, "File report-1.pdf yang tersimpan kemarin masih valid.")).toBe("");
  });

  it("flags markdown-bold numbers (drill run 6: '**3** endpoint dengan **12** request')", () => {
    const out = numericClaimSuffix(noTools, "kemarin aku sudah menguji **3** endpoint dengan total **12** request yang dikirim, menemukan **2** temuan 🌸");
    expect(out).toContain("3 endpoint + 12 request");
    expect(numericClaimSuffix(noTools, "Ada **4** endpoint di halaman itu.")).toBe("");
  });

  it("flags multi-count recaps even with verbs outside the list (drill run 4)", () => {
    const out = numericClaimSuffix(noTools, "pengujian yang mencakup 3 endpoint dengan total 12 request berhasil menemukan 2 temuan");
    expect(out).toContain("perkiraan");
  });
});

// ── 2026-09-24: gate leaks found by the 9router narration drill ──
// (1) vulnerability-class vocab + "uji" must mark a pentest ask (URL lab was
// filed into the reading list — leak #5); (2) URL-bearing asks with only weak
// move-verbs must never schedule reminders (phantom 18:00 wake).
import { isPentestAsk } from "./library";
import { detectReminderIntent, detectReminderCancels } from "./reminderIntent";

describe("pentest-ask gate: vulnerability-class vocab (leak #5)", () => {
  it("flags 'uji IDOR di <url>' as pentest work", () => {
    expect(isPentestAsk("uji IDOR di https://lab.example/api/cek-nik?id=1")).toBe(true);
  });
  it("flags common vuln-class words even without tool names", () => {
    for (const w of ["uji xss", "cek ssrf", "sql injection di sini", "request smuggling desync", "coba payload csrf", "no-sql injection test"]) {
      expect(isPentestAsk(w)).toBe(true);
    }
  });
  it("keeps ordinary reading asks outside the gate", () => {
    expect(isPentestAsk("baca artikel ini https://example.com/post/1 dong")).toBe(false);
    expect(isPentestAsk("rangkum https://example.com/guide ya")).toBe(false);
  });
});

describe("URL-bearing asks need a strong reminder verb (phantom 18:00)", () => {
  it("does not schedule from 'uji IDOR di <url> ... ganti id ke angka lain'", () => {
    expect(detectReminderIntent("uji IDOR di https://lab.example/api/cek-nik?id=1 — ganti id ke angka lain dan bandingkan")).toBeNull();
  });
  it("does not cancel from weak-verb URL asks either", () => {
    expect(detectReminderCancels("pindah ke https://lab.example/api/v2 lalu bandingkan").length).toBe(0);
  });
  it("still schedules strong-verb URL asks", () => {
    expect(detectReminderIntent("ingetin aku cek https://example.com/status jam 9 pagi")).not.toBeNull();
  });
});

describe("structured action receipt (collectActionRecords triple-sourcing)", () => {
  it("builds records from turn-window tool_calls + results", () => {
    const msgs = [
      { role: "user", content: "uji" },
      { role: "assistant", content: null, tool_calls: [{ id: "a1", function: { name: "poc_verify", arguments: '{"url":"https://lab/x"}' } }] },
      { role: "tool", tool_call_id: "a1", content: "✅ PoC STABIL 3/3" },
    ] as never;
    const recs = collectActionRecords(msgs, []);
    expect(recs.length).toBe(1);
    expect(recs[0].name).toBe("poc_verify");
    expect(recs[0].result).toContain("PoC STABIL");
  });
  it("backfills summarized-away executions from the ledger with a placeholder", () => {
    const recs = collectActionRecords([] as never, [{ name: "pentest_scan", args: "{}", executed: true, prior: true }]);
    expect(recs.length).toBe(1);
    expect(recs[0].result).toBe(EXECUTED_PLACEHOLDER);
    expect(recs[0].prior).toBe(true);
  });
});
