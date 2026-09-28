// unrecordedProofNote — the guard for the 2026-09-28 15:36 live turn.
//
// That turn PROVED something (POST /api/login with a payload returned HTTP 200),
// then its `finding_add` FAILED ("Error: judul temuan wajib" — the model omitted
// the title), and it delivered a PDF anyway. The PDF is real and complete for the
// seven findings from earlier turns; the one thing this turn proved is silently
// missing from it. Nothing said so: `unrecordedFindingClaimNote` only fires when
// the model CLAIMS it recorded something, and here it said nothing — which is the
// worse case, because the user holds a report that looks finished.
//
// The guard is fact-based on purpose (tool results, never prose), so the tests
// below are mostly about the three facts, and about NOT firing on the two
// ordinary shapes that look similar.

import { describe, expect, it } from "vitest";
import { unrecordedProofNote, type ChatMessage } from "./agent";

const LAB = "6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** The live turn, transcribed from AUDIT-2026-09-28.log rows 08:36:32–08:37:02. */
const LIVE = [
  { role: "user" as const, content: "full pentest menyeluruh di /login dan buatkan report pdf nya" },
  {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      call("a1", "http_request"),
      call("a2", "web_audit"),
      call("a3", "js_mine"),
      call("a4", "finding_list"),
      call("a5", "http_request", { url: `https://${LAB}/api/login`, method: "POST" }),
      call("a6", "finding_add", { target: `https://${LAB}/login`, impact: "x", steps: "y" }),
      call("a7", "report_pdf", { target: LAB }),
    ],
  },
  { role: "tool" as const, tool_call_id: "a1", content: "HTTP GET /login -> 200" },
  { role: "tool" as const, tool_call_id: "a2", content: "4 findings" },
  { role: "tool" as const, tool_call_id: "a3", content: "12 endpoints mined" },
  { role: "tool" as const, tool_call_id: "a4", content: "7 open findings" },
  { role: "tool" as const, tool_call_id: "a5", content: "HTTP POST /api/login -> 200 OK (application/json)" },
  { role: "tool" as const, tool_call_id: "a6", content: "Error: judul temuan wajib" },
  { role: "tool" as const, tool_call_id: "a7", content: "PDF report-2026-09-28T08-37-02-995Z.pdf saved" },
] as unknown as ChatMessage[];

const DELIVERED = { reportDelivered: true };

describe("unrecordedProofNote — the live 15:36 shape", () => {
  it("fires: a proof was produced, the save failed, a report shipped", () => {
    const note = unrecordedProofNote(LIVE, DELIVERED);
    expect(note).not.toBe("");
    // It must name the tool that proved it, the actual failure, and the next step.
    expect(note).toContain("http_request");
    expect(note).toContain("judul temuan wajib");
    expect(note).toContain("catat temuannya");
  });

  it("fires regardless of what the model claimed (the silent case is the whole point)", () => {
    const silent = LIVE.map((m) =>
      m.role === "assistant" ? { ...m, content: "Laporan sudah dibuat ya." } : m
    ) as unknown as ChatMessage[];
    expect(unrecordedProofNote(silent, DELIVERED)).not.toBe("");
  });
});

describe("unrecordedProofNote — must NOT fire on the ordinary shapes", () => {
  it("silent when the finding WAS recorded (the report then contains it)", () => {
    const ok = LIVE.map((m) =>
      m.tool_call_id === "a6" ? { ...m, content: "Temuan dicatat: F-mu123" } : m
    ) as unknown as ChatMessage[];
    expect(unrecordedProofNote(ok, DELIVERED)).toBe("");
  });

  it("silent when no report was delivered (nothing to be incomplete about)", () => {
    expect(unrecordedProofNote(LIVE, { reportDelivered: false })).toBe("");
  });

  it("silent when nothing was proven — the probe itself failed", () => {
    const failedProbe = LIVE.map((m) =>
      m.tool_call_id === "a5" ? { ...m, content: "HTTP POST /api/login -> 401 Unauthorized" } : m
    ) as unknown as ChatMessage[];
    expect(unrecordedProofNote(failedProbe, DELIVERED)).toBe("");
  });

  it("FIRES when nothing was recorded at all and the store is empty (live 15:58 shape)", () => {
    // The 15:58 turn probed, never called finding_add, and delivered a report.
    const noAttempt = LIVE.filter(
      (m) => m.role !== "tool" || m.tool_call_id !== "a6"
    ) as unknown as ChatMessage[];
    const note = unrecordedProofNote(noAttempt, { reportDelivered: true, recordedHosts: [] });
    expect(note).not.toBe("");
    expect(note).toContain("tidak ada temuan yang dicatat");
  });

  it("SILENT when the PROOF's own host is already in the store (correct behaviour)", () => {
    // Measured live 15:58: the model re-ran the SQLi UNION on this lab, that
    // finding is #1 of the delivered PDF, and NOT recording a duplicate is
    // right. Accusing here would be a false accusation.
    const noAttempt = LIVE.filter(
      (m) => m.role !== "tool" || m.tool_call_id !== "a6"
    ) as unknown as ChatMessage[];
    expect(unrecordedProofNote(noAttempt, { reportDelivered: true, recordedHosts: [LAB] })).toBe("");
  });

  it("FIRES when the store has a finding for a DIFFERENT host (never silence across hosts)", () => {
    const other = LIVE.filter(
      (m) => m.role !== "tool" || m.tool_call_id !== "a6"
    ) as unknown as ChatMessage[];
    const note = unrecordedProofNote(other, {
      reportDelivered: true,
      recordedHosts: ["some-other-lab.example"],
    });
    expect(note).not.toBe("");
  });

  it("silent when the only tool results are ordinary reads", () => {
    const readsOnly = [
      { role: "user" as const, content: "cek /login" },
      {
        role: "assistant" as const,
        content: "Selesai.",
        tool_calls: [call("b1", "web_audit"), call("b2", "report_pdf")],
      },
      { role: "tool" as const, tool_call_id: "b1", content: "4 findings" },
      { role: "tool" as const, tool_call_id: "b2", content: "PDF saved" },
    ] as unknown as ChatMessage[];
    expect(unrecordedProofNote(readsOnly, DELIVERED)).toBe("");
  });

  it("empty / missing input is silent, never a throw", () => {
    expect(unrecordedProofNote([], DELIVERED)).toBe("");
    expect(unrecordedProofNote(LIVE, { reportDelivered: false })).toBe("");
  });
});
