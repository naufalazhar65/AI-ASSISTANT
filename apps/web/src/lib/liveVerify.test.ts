/**
 * Tests for the Live-voice post-turn verifier (`liveVerify.ts`).
 *
 * The safety property under test: a Live turn narrating an action as done
 * ("Udah kubuka di browser ya") must not stand unverified when the tool
 * ledger shows nothing executed in the turn window — the Cozy 2026-10-02
 * shape. Both directions are locked: fabrication fires, honest turns
 * (executed, admitted, future) stay silent.
 */

import { describe, expect, it } from "vitest";

import { LIVE_FINDING_NOUN_RE, LIVE_SECURITY_NOUN_RE, recordLiveToolRun, verifyLiveTurn } from "./liveVerify";

const U = (n: number) => `liveverify_case${n}`;

describe("verifyLiveTurn — clean turns stay silent", () => {
  it("plain chatter with no runs is clean", () => {
    const v = verifyLiveTurn(U(1), "Halo beb, apa kabar hari ini?");
    expect(v.verdict).toBe("clean");
    expect(v.note).toBe("");
    expect(v.executed).toEqual([]);
  });

  it("empty narration is clean", () => {
    expect(verifyLiveTurn(U(2), "   ").verdict).toBe("clean");
  });

  it("a real execution legitimizes the claim", () => {
    recordLiveToolRun(U(3), "mac_open", true);
    const v = verifyLiveTurn(U(3), "Udah kubuka di browser-mu ya beb");
    expect(v.verdict).toBe("clean");
    expect(v.executed).toEqual(["mac_open"]);
  });

  it("admission of non-execution stays silent", () => {
    const v = verifyLiveTurn(U(4), "Belum kubuka linknya, bentar ya beb");
    expect(v.verdict).toBe("clean");
  });

  it("future promise stays silent", () => {
    const v = verifyLiveTurn(U(5), "Nanti kubuka linknya ya beb");
    expect(v.verdict).toBe("clean");
  });
});

describe("verifyLiveTurn — fabrication fires", () => {
  it("bare Cozy-shaped claim with zero executions is flagged", () => {
    const v = verifyLiveTurn(U(6), "Udah kubuka di browser-mu ya beb");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("tool-name claim without execution names the tool", () => {
    const v = verifyLiveTurn(U(7), "hasil dari http_request menunjukkan 200 OK");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("http_request");
    expect(v.note).toContain("tidak tercatat");
  });

  it("refused tool claimed as success is named as refused", () => {
    recordLiveToolRun(U(8), "mac_open", false);
    const v = verifyLiveTurn(U(8), "Udah kubuka di browser ya");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("mac_open");
    expect(v.note).toContain("ditolak/belum dikonfirmasi");
  });

  it("lone refused tool is attributed on a bare claim", () => {
    recordLiveToolRun(U(9), "save_note", false);
    const v = verifyLiveTurn(U(9), "Udah kusimpan catatannya ya");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("save_note");
  });

  it("turn window excludes out-of-window executions — but lookback still covers them", () => {
    // 2026-10-03 false-positive fix: a tool that ran seconds before the
    // new turn's window (turn split) must not be accused.
    recordLiveToolRun(U(10), "mac_open", true);
    const v = verifyLiveTurn(U(10), "Udah kubuka di browser ya", Date.now() + 1000);
    expect(v.verdict).toBe("clean");
    expect(v.executed).toEqual([]);
  });

  it("in-window executions are listed", () => {
    recordLiveToolRun(U(11), "places_search", true);
    const v = verifyLiveTurn(U(11), "Nih daftarnya ya", Date.now() - 60_000);
    expect(v.verdict).toBe("clean");
    expect(v.executed).toEqual(["places_search"]);
  });
});

describe("verifyLiveTurn — cross-turn lookback", () => {
  it("named tool executed 9 minutes ago stays silent", () => {
    recordLiveToolRun(U(12), "http_request", true, Date.now() - 9 * 60_000);
    const v = verifyLiveTurn(U(12), "hasil dari http_request menunjukkan 200 OK", Date.now() - 60_000);
    expect(v.verdict).toBe("clean");
  });

  it("named tool executed 20 minutes ago still flags", () => {
    recordLiveToolRun(U(13), "http_request", true, Date.now() - 20 * 60_000);
    const v = verifyLiveTurn(U(13), "hasil dari http_request menunjukkan 200 OK", Date.now() - 60_000);
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("http_request");
  });

  it("bare claim with a 5-second-prior execution stays silent", () => {
    recordLiveToolRun(U(14), "mac_open", true, Date.now() - 5_000);
    const v = verifyLiveTurn(U(14), "Udah kubuka di browser-mu ya beb", Date.now() - 1000);
    expect(v.verdict).toBe("clean");
  });

  it("bare claim with only a 20-minute-old execution still flags", () => {
    recordLiveToolRun(U(15), "mac_open", true, Date.now() - 20 * 60_000);
    const v = verifyLiveTurn(U(15), "Udah kubuka di browser-mu ya beb", Date.now() - 60_000);
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("lookback never silences on refusals alone", () => {
    // Refusal 5s ago but outside the turn window: it must neither silence
    // via lookback (only ok=true silences) nor attribute (attribution is
    // window-scoped) — the generic note fires.
    recordLiveToolRun(U(16), "mac_open", false, Date.now() - 5_000);
    const v = verifyLiveTurn(U(16), "Udah kubuka di browser ya", Date.now() - 1000);
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });
});

describe("verifyLiveTurn — blanket refusals without a scope check", () => {
  it("live jalanin refusal with zero tools is flagged", () => {
    // Exact 2026-10-03 Live shape: colloquial verb, no reason, no tools.
    const v = verifyLiveTurn(U(17), "Aku nggak bisa jalanin penetration test langsung beb");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tanpa memeriksa scope");
  });

  it("pernah-infix hacking refusal is flagged", () => {
    const v = verifyLiveTurn(U(18), "aku nggak pernah bisa jalanin aksi hacking-nya sendiri");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tanpa memeriksa scope");
  });

  it("reason-giving refusal stays silent", () => {
    const v = verifyLiveTurn(U(19), "nggak bisa pentest di website orang lain tanpa izin tertulis");
    expect(v.verdict).toBe("clean");
  });

  it("epistemic hedging stays silent", () => {
    const v = verifyLiveTurn(U(20), "belum bisa memastikan ini vuln atau bukan");
    expect(v.verdict).toBe("clean");
  });

  it("refusal after a scope check stays silent", () => {
    recordLiveToolRun(U(21), "engagement_list", true);
    const v = verifyLiveTurn(U(21), "Aku nggak bisa jalanin penetration test langsung beb");
    expect(v.verdict).toBe("clean");
  });
});

describe("verifyLiveTurn — completed setup claims", () => {
  it("udah-aku-setting shape is flagged", () => {
    // Exact 2026-10-03 Live shape: past marker + aku + setup verb.
    const v = verifyLiveTurn(U(22), "Udah aku setting biar semuanya jalan smoothly");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("reversed aku-udah-siapin shape is flagged", () => {
    const v = verifyLiveTurn(U(23), "aku udah siapin scan kerentanannya");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("impersonal beres without standalone aku stays silent", () => {
    // "kerjaanku" carries no standalone aku — must not fire.
    const v = verifyLiveTurn(U(24), "kerjaanku udah beres semua");
    expect(v.verdict).toBe("clean");
  });
});

describe("verifyLiveTurn — noun-anchored completion/discovery", () => {
  it("pengetesan udah jalan shape is flagged", () => {
    // Exact 2026-10-03 Live shape: work noun + past marker + jalan.
    const v = verifyLiveTurn(U(25), "Oke, semua modul pengetesan di lab Cozy udah jalan lancar ya");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("pemindaian selesai + nemu celah shape is flagged", () => {
    const v = verifyLiveTurn(U(26), "Hasil pemindaian kerentanan udah selesai, dan aku nemu beberapa celah potensial");
    expect(v.verdict).toBe("flagged");
    expect(v.note).toContain("tidak ada tool");
  });

  it("noun parity: shared + new nouns match the composed Live set", () => {
    for (const w of ["penetration test", "pentest", "kerentanan", "hacking", "exploit", "scan kerentanan", "celah", "temuan", "pemindaian", "pengetesan"]) {
      expect(LIVE_SECURITY_NOUN_RE.test(w)).toBe(true);
    }
    for (const w of ["celah", "temuan", "kerentanan", "ditemukan 3 vuln"]) {
      expect(LIVE_FINDING_NOUN_RE.test(w)).toBe(true);
    }
  });

  it("eating selesai stays silent", () => {
    const v = verifyLiveTurn(U(27), "Udah selesai makan, lanjut nanti ya");
    expect(v.verdict).toBe("clean");
  });

  it("street jalan stays silent", () => {
    // "di jalan" is the street, not running work — lookbehind blocks it.
    const v = verifyLiveTurn(U(28), "Udah di jalan, nanti bahas pemindaian ya");
    expect(v.verdict).toBe("clean");
  });

  it("nemu artikel stays silent", () => {
    // pentest names the TOPIC, not the find — finding nouns only.
    const v = verifyLiveTurn(U(29), "Aku nemu artikel bagus soal pentest kemarin");
    expect(v.verdict).toBe("clean");
  });
});
