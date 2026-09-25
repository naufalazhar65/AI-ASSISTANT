// turnWindow.test.ts — the guards must judge THIS turn, not the channel history.
//
// Live 2026-09-25 11:37: the Discord channel passed its rolling history, which
// still held the 11:02 turn's `http_request /api/cek-nik`. The zero-contact
// guard therefore saw the endpoint as "touched" and stayed silent — on a turn
// that ran ZERO probes and answered with a stale findings dump.
import { describe, expect, it } from "vitest";
import {
  endpointTriageNote,
  numericClaimSuffix,
  toolActuallyRan,
  turnRanTool,
  turnWindow,
  unrecordedFindingNote,
} from "./agent";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** A prior turn that really did probe /cek-nik (11:02), still in history. */
const oldTurn = [
  { role: "user", content: `uji ${LAB}/cek-nik` },
  { role: "assistant", content: null, tool_calls: [call("old1", "http_request", { url: `${LAB}/api/cek-nik?id=1` })] },
  { role: "tool", tool_call_id: "old1", content: '{"nik":"3571010101010001"}' },
  { role: "assistant", content: null, tool_calls: [call("old2", "poc_verify", { url: `${LAB}/api/cek-nik?id=1'`, times: 3 })] },
  { role: "tool", tool_call_id: "old2", content: "✅ PoC STABIL & terkonfirmasi 3/3" },
  { role: "assistant", content: "IDOR terkonfirmasi." },
  { role: "user", content: "halo" },
  { role: "assistant", content: "hai" },
];

/** The 11:37 turn: zero probes, only store reads + a report. */
const staleDumpTurn = [
  ...oldTurn,
  { role: "user", content: `full pentest menyeluruh di ${LAB}/cek-nik dan buatkan report markdown` },
  { role: "assistant", content: null, tool_calls: [call("n1", "finding_list", { target: `${LAB}/cek-nik` })] },
  { role: "tool", tool_call_id: "n1", content: "6 temuan:\n• [CRITICAL 9.8] SQLi" },
  { role: "assistant", content: null, tool_calls: [call("n2", "report_generate", { target: `${LAB}/cek-nik` })] },
  { role: "tool", tool_call_id: "n2", content: "# Laporan Pentest\nTotal temuan: 6" },
  { role: "assistant", content: "Selesai. Laporan pentest menyeluruh sudah siap: 6 temuan termasuk IDOR /api/cek-nik HIGH 7.5." },
];

describe("turnWindow", () => {
  it("returns only what follows the last user message", () => {
    const w = turnWindow(staleDumpTurn as never);
    expect(w.every((m) => m.role !== "user")).toBe(true);
    expect(w.length).toBe(5);
  });
  it("returns everything when there is no user message", () => {
    expect(turnWindow([{ role: "assistant" }])).toHaveLength(1);
  });
});

describe("guards ignore OLDER turns sitting in history (the 11:37 bug)", () => {
  it("zero-contact fires even though an earlier turn probed the same endpoint", () => {
    const note = endpointTriageNote(staleDumpTurn as never, "Selesai. Laporan pentest menyeluruh sudah siap: 6 temuan termasuk IDOR /api/cek-nik HIGH 7.5.");
    expect(note).toMatch(/tidak menyentuh/i);
  });

  it("turnRanTool ignores a prior turn's finding_add", () => {
    const withOldAdd = [
      ...oldTurn,
      { role: "assistant", content: null, tool_calls: [call("old3", "finding_add", { title: "IDOR" })] },
      { role: "tool", tool_call_id: "old3", content: "F-1 tercatat" },
      { role: "user", content: "uji lagi" },
      { role: "assistant", content: "ok" },
    ];
    expect(turnRanTool(withOldAdd as never, "finding_add")).toBe(false);
  });

  it("toolActuallyRan ignores a prior turn's http_request", () => {
    const msgs = [
      ...oldTurn,
      { role: "user", content: "sekarang clamped?" },
      { role: "assistant", content: "sudah kujalankan http_request, hasilnya 200" },
    ];
    expect(toolActuallyRan(msgs as never, "http_request")).toBe(false);
  });

  it("unrecordedFindingNote still fires when only an OLDER turn had the proof", () => {
    const note = unrecordedFindingNote(staleDumpTurn as never, "Selesai. Laporan pentest menyeluruh sudah siap: 6 temuan termasuk IDOR.");
    expect(note).toBe(""); // no proof in THIS turn → nothing to nag about
  });

  it("numericClaimSuffix ignores a prior turn's probe", () => {
    const claim = "sudah kucek 5 endpoint dengan 12 request terkirim";
    const msgs = [...oldTurn, { role: "user", content: claim }, { role: "assistant", content: claim }];
    expect(numericClaimSuffix(msgs as never, claim)).not.toBe("");
  });
});

describe("guards still honour THIS turn's work (no over-correction)", () => {
  it("zero-contact stays silent when THIS turn probed the path", () => {
    const msgs = [
      ...oldTurn,
      { role: "user", content: `uji ${LAB}/cek-nik` },
      { role: "assistant", content: null, tool_calls: [call("p1", "path_traversal", { url: `${LAB}/cek-nik`, params: "id" })] },
      { role: "tool", tool_call_id: "p1", content: "📂 PATH TRAVERSAL — LEAD" },
      { role: "assistant", content: "Selesai, endpoint sudah diuji dan aman." },
    ];
    expect(endpointTriageNote(msgs as never, "Selesai, endpoint sudah diuji dan aman.")).toBe("");
  });

  it("a confirm continuation keeps round-1 calls inside the window", () => {
    // In a continuation the pending transcript ends with the ORIGINAL ask (the
    // "ya" is delivered as confirm_calls, not as a message), so the round-1
    // probe must still count.
    const msgs = [
      { role: "user", content: `uji ${LAB}/cek-nik lalu buatkan pdf` },
      { role: "assistant", content: null, tool_calls: [call("c1", "path_traversal", { url: `${LAB}/cek-nik`, params: "id" })] },
      { role: "tool", tool_call_id: "c1", content: "LEAD" },
      { role: "assistant", content: null, tool_calls: [call("c2", "report_pdf", { target: `${LAB}/cek-nik` })] },
      { role: "tool", tool_call_id: "c2", content: "PDF written" },
      { role: "assistant", content: "Selesai, endpoint sudah diuji dan aman." },
    ];
    expect(endpointTriageNote(msgs as never, "Selesai, endpoint sudah diuji dan aman.")).toBe("");
  });
});
