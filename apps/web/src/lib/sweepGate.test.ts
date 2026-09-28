// sweepGate — a sweep-grade ask must be backed by a REAL probe before a report
// is produced from it.
//
// The fixture is the real 14:48 Discord turn: five read-only calls
// (http_request, web_audit, js_mine, finding_list, report_save) and a report
// written from findings recorded in an EARLIER turn. The honesty stack already
// corrected the reply; this gate stops the report itself, because a correction
// is not a fix — the user still got a report from a turn that tested nothing.
//
// Every test is two-directional. Over-blocking would be a worse regression than
// the bug being fixed, so "must never block" is asserted as loudly as "must
// block".

import { describe, expect, it } from "vitest";
import {
  isFullSweepAsk,
  sweepGateRefusal,
  sweepReportGate,
  SWEEP_REPORT_TOOLS,
  turnHasProbe,
  type SweepTurnCall,
} from "./sweepGate";

/** The real ask from 2026-09-28 14:48. */
const LIVE_ASK =
  "mia coba lakukan full pentest secara menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/login dan buatkan report pdf nya";

/** A permissive stand-in for library.ts isPentestAsk (reused in agent.ts). */
const isSecurityAsk = (t: string) => /pentest|uji|scan|audit|kerentanan|keamanan|security|test|vuln/i.test(t);

/** The five read-only calls of the live turn, verbatim from the audit log. */
const READ_ONLY_TURN: SweepTurnCall[] = [
  { name: "http_request", executed: true },
  { name: "web_audit", executed: true },
  { name: "js_mine", executed: true },
  { name: "finding_list", executed: true },
];

describe("isFullSweepAsk", () => {
  it("is true for the live ask", () => {
    expect(isFullSweepAsk(LIVE_ASK, isSecurityAsk)).toBe(true);
  });

  it("is true for the common sweep phrasings in Indonesian and English", () => {
    for (const ask of [
      "full pentest menyeluruh",
      "pentest secara menyeluruh di target itu",
      "uji semua endpoint secara lengkap",
      "do a comprehensive pentest",
      "test the entire application",
      "scan semua permukaan serangan",
    ]) {
      expect(isFullSweepAsk(ask, isSecurityAsk)).toBe(true);
    }
  });

  it("is false for a SINGLE check, even though it is a security ask", () => {
    // Over-blocking here would be a regression, not a safeguard.
    for (const ask of [
      "cek header /api/x",
      "uji IDOR di /api/cek-nik",
      "apakah /login rentan CVE-2026-63077",
      "scan port 22 di lab itu",
      "apa isi file /api/admin-data",
    ]) {
      expect(isFullSweepAsk(ask, isSecurityAsk)).toBe(false);
    }
  });

  it("is false for a non-security ask that happens to say 'penuh'", () => {
    expect(isFullSweepAsk("tulis catatan penuh untuk besok", isSecurityAsk)).toBe(false);
    expect(isFullSweepAsk("", isSecurityAsk)).toBe(false);
  });
});

describe("turnHasProbe", () => {
  it("is false for the live read-only turn", () => {
    expect(turnHasProbe(READ_ONLY_TURN)).toBe(false);
  });

  it("is true as soon as a real prover ran", () => {
    expect(turnHasProbe([...READ_ONLY_TURN, { name: "poc_verify", executed: true }])).toBe(true);
    expect(turnHasProbe([...READ_ONLY_TURN, { name: "param_fuzz", executed: true }])).toBe(true);
    expect(turnHasProbe([...READ_ONLY_TURN, { name: "workflow_fuzz", executed: true }])).toBe(true);
  });

  it("ignores a call recorded as NOT executed (the gate is about what really ran)", () => {
    expect(turnHasProbe([{ name: "poc_verify", executed: false }])).toBe(false);
  });

  it("is false for an empty or missing ledger", () => {
    expect(turnHasProbe([])).toBe(false);
    expect(turnHasProbe(undefined)).toBe(false);
  });
});

describe("sweepReportGate — it MUST refuse the live 14:48 shape", () => {
  it("refuses a report on a sweep ask with only reads so far", () => {
    const d = sweepReportGate({
      userText: LIVE_ASK,
      isPentestAsk: isSecurityAsk,
      toolName: "report_save",
      executed: READ_ONLY_TURN,
      alreadyRefused: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("sweep-ask-without-any-probe");
  });

  it("refuses all three report tools (the PDF path must not be the way around it)", () => {
    for (const t of ["report_generate", "report_save", "report_pdf", "writeup"]) {
      expect(SWEEP_REPORT_TOOLS.has(t)).toBe(true);
      expect(sweepReportGate({ userText: LIVE_ASK, isPentestAsk: isSecurityAsk, toolName: t, executed: READ_ONLY_TURN, alreadyRefused: false }).allow).toBe(false);
    }
  });
});

describe("sweepReportGate — it must NEVER block these", () => {
  const base = { isPentestAsk: isSecurityAsk, alreadyRefused: false } as const;

  it("allows the report once the turn has probed", () => {
    const d = sweepReportGate({
      ...base,
      userText: LIVE_ASK,
      toolName: "report_save",
      executed: [...READ_ONLY_TURN, { name: "poc_verify", executed: true }],
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("this-turn-already-probed");
  });

  it("allows a report on a SINGLE-check ask even with zero probes", () => {
    const d = sweepReportGate({
      ...base,
      userText: "uji IDOR di /api/cek-nik",
      toolName: "report_generate",
      executed: READ_ONLY_TURN,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("not-a-sweep-grade-ask");
  });

  it("allows a non-report tool (the gate is about deliverables, not about work)", () => {
    const d = sweepReportGate({ ...base, userText: LIVE_ASK, toolName: "http_request", executed: READ_ONLY_TURN });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("not-a-report-tool");
  });

  it("allows the SECOND report call in the same turn (one refusal, then serve)", () => {
    // Without this bound a target with nothing to probe would loop refusals
    // until the round budget burned, and the user would get no report at all.
    const d = sweepReportGate({ ...base, userText: LIVE_ASK, toolName: "report_save", executed: READ_ONLY_TURN, alreadyRefused: true });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.reason).toBe("already-refused-once-this-turn");
  });

  it("allows a report on a sweep ask when the turn is NOT a security ask at all", () => {
    const d = sweepReportGate({ ...base, userText: "tulis catatan penuh", toolName: "report_save", executed: READ_ONLY_TURN });
    expect(d.allow).toBe(true);
  });
});

describe("sweepGateRefusal", () => {
  it("is an actionable Error the model can self-correct from (the EMPTY_REPORT pattern)", () => {
    const msg = sweepGateRefusal("report_pdf");
    expect(msg.startsWith("Error:")).toBe(true);
    expect(msg).toContain("belum ada pengujian nyata");
    // It must name the next concrete step, or the model has nothing to act on.
    expect(msg).toContain("payload");
    expect(msg).toContain("poc_verify");
    expect(msg).toContain("finding_add");
    expect(msg).toContain("report_pdf");
  });

  it("offers the honest exit so a model that cannot probe is not trapped", () => {
    expect(sweepGateRefusal("report_save")).toMatch(/tidak ada yang bisa diuji|bilang saja/i);
  });

  it("never claims the report is broken — only that it would mislabel the work", () => {
    const msg = sweepGateRefusal("report_save");
    expect(msg).toContain("salah label");
    expect(msg).not.toMatch(/laporan (rusak|error|gagal)/i);
  });
});
