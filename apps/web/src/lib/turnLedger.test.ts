// turnLedger.test.ts — the truncation-immune execution ledger.
//
// Live bug 2026-09-25 10:49: the turn DID run browser_open + fetch_url against
// /cek-nik, yet endpointTriageNote printed "tidak menyentuh /cek-nik sama
// sekali". Cause: on a long turn buildSummarizedMessages() replaces older
// messages with a prose summary that carries no `tool_calls`, so every guard
// that reads `messages` alone loses the evidence of work that really ran.
//
// The ledger records REAL executions at each dispatch site. It may silence a
// false accusation; it must never license a fabricated claim — hence the
// two-directional tests below.
import { describe, expect, it } from "vitest";
import {
  endpointTriageNote,
  numericClaimSuffix,
  toolActuallyRan,
  toolRunClaimSuffix,
  verdictInflationSuffix,
} from "./agent";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ASK = `uji path traversal di ${LAB}/cek-nik`;
const COMPLETION = "Sudah selesai menguji endpoint tersebut dan aman.";

/** The visible transcript AFTER summarization: early tool_calls are gone. The
 *  rolling-summary carrier is PREPENDED (as summarize() does) so the ask stays
 *  the last user message — that is the turn endpointTriageNote reads. */
function summarizedTail(): Parameters<typeof endpointTriageNote>[0] {
  return [
    { role: "user", content: "[Percakapan sebelumnya — ringkasan]\nTools used earlier: browser_open, fetch_url" },
    { role: "user", content: ASK },
    { role: "assistant", content: COMPLETION },
  ] as unknown as Parameters<typeof endpointTriageNote>[0];
}

describe("ledger silences the false zero-contact accusation", () => {
  it("drops the 'never touched' accusation once the ledger proves a real read-touch", () => {
    const note = endpointTriageNote(summarizedTail(), COMPLETION, [
      { name: "browser_open", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: true },
      { name: "fetch_url", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: true },
    ]);
    // The live false accusation is gone...
    expect(note).not.toMatch(/tidak menyentuh/i);
    // ...but reading a page is NOT testing it, so the completion claim is still
    // flagged. Silence here would be the WORSE bug (fetch tanpa payload ≠ uji).
    expect(note).toMatch(/sudah menguji/i);
  });

  it("a ledger PROBE fully silences the guard (read + real probe = earned completion)", () => {
    const note = endpointTriageNote(summarizedTail(), COMPLETION, [
      { name: "fetch_url", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: true },
      // a real PROBE tool (http_request is deliberately NOT one: a plain GET
      // without a payload marker is a read, not a test).
      { name: "path_traversal", args: JSON.stringify({ url: `${LAB}/cek-nik`, params: "id" }), executed: true },
    ]);
    expect(note).toBe("");
  });

  it("a plain http_request (no payload) still does NOT count as a test", () => {
    const note = endpointTriageNote(summarizedTail(), COMPLETION, [
      { name: "http_request", args: JSON.stringify({ url: `${LAB}/cek-nik`, method: "GET" }), executed: true },
    ]);
    expect(note).toMatch(/sudah menguji/i);
  });

  it("without the ledger the same turn DOES accuse (the live bug reproduces)", () => {
    expect(endpointTriageNote(summarizedTail(), COMPLETION)).toMatch(/tidak menyentuh/i);
  });
});

describe("ledger never licenses a fabricated claim", () => {
  it("a non-executed ledger entry does NOT silence the guard", () => {
    const note = endpointTriageNote(summarizedTail(), COMPLETION, [
      { name: "browser_open", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: false },
    ]);
    expect(note).toMatch(/tidak menyentuh/i);
  });

  it("a ledger entry for a DIFFERENT endpoint does not count as touching /cek-nik", () => {
    const note = endpointTriageNote(summarizedTail(), COMPLETION, [
      { name: "fetch_url", args: JSON.stringify({ url: `${LAB}/api/lain` }), executed: true },
    ]);
    expect(note).toMatch(/tidak menyentuh/i);
  });

  it("toolRunClaimSuffix still fires when no tool actually ran", () => {
    const msgs = [{ role: "user", content: ASK }, { role: "assistant", content: "sudah kujalankan http_request dan hasilnya 200" }] as never;
    expect(toolRunClaimSuffix(msgs, "sudah kujalankan http_request dan hasilnya 200")).not.toBe("");
  });

  it("toolActuallyRan is false for an unexecuted ledger entry", () => {
    expect(toolActuallyRan([], "http_request", [{ name: "http_request", executed: false }])).toBe(false);
    expect(toolActuallyRan([], "http_request", [{ name: "http_request", executed: true }])).toBe(true);
  });
});

describe("ledger credits an earned verifier upgrade", () => {
  it("verdictInflationSuffix stays silent when poc_verify really ran earlier", () => {
    const msgs = [
      { role: "user", content: ASK },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "a", type: "function", function: { name: "xss_hunt", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "a", content: "LEADS: Stored XSS candidate" },
      { role: "assistant", content: "temuan XSS terkonfirmasi" },
    ] as never;
    // visible transcript: fires (candidate, no verifier)
    expect(verdictInflationSuffix(msgs, "temuan XSS terkonfirmasi")).not.toBe("");
    // ledger: the verifier ran earlier and was summarized away → earned
    expect(
      verdictInflationSuffix(msgs, "temuan XSS terkonfirmasi", [{ name: "poc_verify", executed: true }])
    ).toBe("");
  });
});

describe("ledger backs an otherwise-invented count", () => {
  it("numericClaimSuffix stays silent when a real probe ran earlier", () => {
    const claim = "sudah kucek 5 endpoint dengan 12 request terkirim";
    const msgs = [{ role: "user", content: ASK }, { role: "assistant", content: claim }] as never;
    expect(numericClaimSuffix(msgs, claim)).not.toBe("");
    expect(numericClaimSuffix(msgs, claim, [{ name: "http_request", executed: true }])).toBe("");
  });
});
