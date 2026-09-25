// findingGate.test.ts — the write-path gate that stops a REFUTED claim reaching
// the store.
//
// The drill case is reproduced here verbatim: a turn tested `?id=1;-- -` on the
// owner's lab, the clean `?id=1` returned byte-identical output, the real SQLi
// payload was 404 — and a HIGH CWE-89 finding was filed anyway.
import { describe, expect, it } from "vitest";
import { findingAddGate, findingIsInjectionClass, pocRunWitnesses } from "./findingGate";
import { toolResultExecuted } from "./agent";
import type { PocRun } from "./pocRuns";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const PAYLOAD_URL = `${LAB}/api/cek-nik?id=1;-- -`;
const CLEAN_URL = `${LAB}/api/cek-nik?id=1`;

/** The finding exactly as the live 2026-09-25 turn recorded it. */
const LIVE_FINDING = {
  title: "SQL Injection pada parameter id endpoint /api/cek-nik",
  severity: "high",
  cwe: "CWE-89",
  owasp: "A03:2025 Injection",
  target: `${LAB}/cek-nik`,
  text: [
    "SQL Injection pada parameter id endpoint /api/cek-nik",
    `Payload 'id=1;-- -' menghasilkan data sensitif.`,
    `2. Kirim request GET ke ${PAYLOAD_URL} melalui browser atau alat bantu.`,
  ].join("\n"),
};

const run = (over: Partial<PocRun>): PocRun => ({
  url: PAYLOAD_URL,
  method: "GET",
  verdict: "confirmed",
  differs: true,
  status: 200,
  len: 292,
  at: "2026-09-25T05:30:53.000Z",
  ...over,
});

describe("findingIsInjectionClass", () => {
  it("recognises the injection family by title and by CWE", () => {
    expect(findingIsInjectionClass({ title: "SQL Injection pada parameter id" })).toBe(true);
    expect(findingIsInjectionClass({ title: "sesuatu", cwe: "CWE-89" })).toBe(true);
    expect(findingIsInjectionClass({ title: "injeksi perintah lewat parameter" })).toBe(true);
    expect(findingIsInjectionClass({ title: "NoSQL auth bypass", cwe: "CWE-943" })).toBe(true);
  });

  it("does NOT swallow classes proven by other means or unrelated bugs", () => {
    expect(findingIsInjectionClass({ title: "Missing security headers", cwe: "CWE-693" })).toBe(false);
    expect(findingIsInjectionClass({ title: "DOM XSS di sink hash" })).toBe(false);
    expect(findingIsInjectionClass({ title: "HTTP request smuggling", cwe: "CWE-444" })).toBe(false);
    expect(findingIsInjectionClass({ title: "XXE via entitas eksternal", cwe: "CWE-611" })).toBe(false);
    // A bare OWASP label on a non-injection title must not trip the gate.
    expect(findingIsInjectionClass({ title: "Cookie tanpa HttpOnly", owasp: "A03:2025 Injection" })).toBe(false);
  });
});

describe("pocRunWitnesses", () => {
  it("a host-level run speaks for its whole host", () => {
    expect(pocRunWitnesses(`${LAB}/`, `${LAB}/cek-nik`, "apa saja")).toBe(true);
  });

  it("a path-level run must be referenced by the finding itself", () => {
    expect(pocRunWitnesses(PAYLOAD_URL, `${LAB}/cek-nik`, LIVE_FINDING.text)).toBe(true);
    expect(pocRunWitnesses(`${LAB}/api/lain`, `${LAB}/cek-nik`, LIVE_FINDING.text)).toBe(false);
  });

  it("never witnesses another host", () => {
    expect(pocRunWitnesses("https://other.example.com/api/cek-nik", `${LAB}/cek-nik`, LIVE_FINDING.text)).toBe(false);
  });
});

describe("findingAddGate — refutation", () => {
  it("blocks the live drill finding: poc said the payload changed nothing", () => {
    const d = findingAddGate(LIVE_FINDING, [run({ verdict: "no-signal", differs: false })]);
    expect(d.allow).toBe(false);
    expect(d.block).toBe("no-signal");
    expect(d.reason).toMatch(/TIDAK ADA SINYAL/);
    expect(d.reason).toMatch(/JANGAN menghapus baseline/i);
    // Must be readable by the honesty guards as a refusal, never as a stored write.
    expect(/refused to execute/i.test(d.reason)).toBe(true);
  });

  it("a refuted endpoint stays blocked even if another run on it looked confirmed", () => {
    const d = findingAddGate(LIVE_FINDING, [
      run({ verdict: "confirmed", differs: true }),
      run({ verdict: "no-signal", differs: false }),
    ]);
    expect(d.block).toBe("no-signal");
  });
});

describe("findingAddGate — unbacked claims", () => {
  it("blocks an injection HIGH with no poc run at all", () => {
    const d = findingAddGate(LIVE_FINDING, []);
    expect(d.allow).toBe(false);
    expect(d.block).toBe("no-proof");
    expect(d.reason).toMatch(/belum punya bukti diferensial/i);
  });

  it("blocks when the only evidence is a run on a different host", () => {
    const d = findingAddGate(LIVE_FINDING, [run({ url: "https://other.example.com/api/cek-nik?id=1;-- -" })]);
    expect(d.block).toBe("no-proof");
  });

  it("blocks when the run is inconclusive (determinism is not proof)", () => {
    const d = findingAddGate(LIVE_FINDING, [run({ verdict: "inconclusive", differs: false })]);
    expect(d.block).toBe("no-proof");
  });

  it("allows once a confirming run exists for that endpoint", () => {
    expect(findingAddGate(LIVE_FINDING, [run({ verdict: "confirmed" })]).allow).toBe(true);
  });
});

describe("refusal is not a write (cross-module lock)", () => {
  it("the refusal reads as a NON-execution so a 'sudah kucatat' claim gets corrected", () => {
    const d = findingAddGate(LIVE_FINDING, [run({ verdict: "no-signal", differs: false })]);
    expect(toolResultExecuted(d.reason)).toBe(false);
  });

  it("a real store result still reads as an execution", () => {
    expect(toolResultExecuted("✅ Temuan dicatat: [HIGH CVSS 8.1] SQL Injection (F-abc123)")).toBe(true);
  });
});

describe("findingAddGate — deliberately narrow", () => {
  it("leaves medium/low alone (warning path stays)", () => {
    expect(findingAddGate({ ...LIVE_FINDING, severity: "medium" }, []).allow).toBe(true);
    expect(findingAddGate({ ...LIVE_FINDING, severity: "low" }, []).allow).toBe(true);
  });

  it("leaves non-injection classes alone", () => {
    const d = findingAddGate({ title: "Missing security headers", severity: "high", cwe: "CWE-693", target: LAB, text: "" }, []);
    expect(d.allow).toBe(true);
  });

  it("honours a proof poc_verify cannot produce (OOB / browser / socket)", () => {
    for (const proof of [
      "bukti via oast_poll: callback ter-atribusi dari IP target",
      "dom_xss_prove PROVEN — handler jalan di Chromium",
      "smuggle_probe CONFIRMED CL.TE desync",
      "marker /etc/passwd terbaca dari baseline-absent",
      "blind_cmdi time-based 6s di atas jitter baseline",
    ]) {
      const d = findingAddGate({ ...LIVE_FINDING, text: `${LIVE_FINDING.text}\n${proof}` }, []);
      expect(d.allow, proof).toBe(true);
    }
  });
});
