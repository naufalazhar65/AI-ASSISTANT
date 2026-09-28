// Two residuals found from the live 2026-09-28 13:18 Discord turn:
//
//  1. the reply pointed at a report file with a CONTENTLESS path
//     ("( / PDF terkait)") — a confident pointer to nothing;
//  2. `redactEvidenceForReport` shipped a live email address in the report.
//
// Both are pure-string fixes, so both lock here. Every test is two-directional:
// the strip must not touch ordinary prose, and the redaction must not eat the
// proof payload (a payload IS the evidence of an XSS/SSTI finding).

import { describe, expect, it } from "vitest";
import { crossFormatArtifactNote, DEFERRED_FORMAT_OFFER_RE, isContentlessReportPath, stripContentlessReportPaths } from "./agent";
import { redactEvidenceForReport } from "./security";
import { redactorResidues } from "./redactScan";

describe("isContentlessReportPath", () => {
  it("flags the live contentless pointer", () => {
    expect(isContentlessReportPath("/ PDF terkait")).toBe(true);
  });

  it("flags placeholder words in any casing / spacing", () => {
    expect(isContentlessReportPath("file nya")).toBe(true);
    expect(isContentlessReportPath("laporan yang terkait")).toBe(true);
    expect(isContentlessReportPath("related file")).toBe(true);
  });

  it("flags a bare directory token with no file name", () => {
    expect(isContentlessReportPath("~/Documents/PROJECT/ai-assistant/apps/web/.data/users/x/reports")).toBe(true);
    expect(isContentlessReportPath("folder laporan/")).toBe(true);
  });

  it("never flags a real file name", () => {
    expect(isContentlessReportPath("report-2026-09-28T06-18-42-231Z.pdf")).toBe(false);
    expect(isContentlessReportPath("report-2026-09-28T05-51-27-465Z.md")).toBe(false);
    expect(isContentlessReportPath("bukti.png")).toBe(false);
  });

  it("an empty token is not contentless (nothing to strip)", () => {
    expect(isContentlessReportPath("")).toBe(false);
  });
});

describe("stripContentlessReportPaths — the live 13:18 reply", () => {
  const live =
    "Mas Naufal, full pentest untuk cozy-kangaroo udah tuntas. File laporan PDF-nya sudah otomatis tersedia di direktori kerja kamu ( / PDF terkait).";

  it("removes the live contentless pointer", () => {
    const out = stripContentlessReportPaths(live);
    expect(out).not.toContain("PDF terkait");
    expect(out).not.toContain("( /");
  });

  it("leaves the rest of the sentence readable (no dangling punctuation)", () => {
    const out = stripContentlessReportPaths(live);
    expect(out).toContain("File laporan PDF-nya");
    expect(out).toMatch(/direktori kerja kamu\.?\s*$/);
    expect(out).not.toMatch(/\s{2,}/);
  });

  it("leaves ordinary prose about folders alone", () => {
    const plain = "Aku menyimpan catatan di folder catatan/ hari ini.";
    expect(stripContentlessReportPaths(plain)).toBe(plain);
  });

  it("leaves a real file name alone even in a report sentence", () => {
    const real = "PDF-nya ada di report-2026-09-28T06-18-42-231Z.pdf";
    expect(stripContentlessReportPaths(real)).toBe(real);
  });

  it("only fires in a sentence that actually claims a report artefact", () => {
    // A bracketed contentless token in a sentence with NO report/pdf/file word
    // at all → untouched, so ordinary prose is never edited.
    const notAReport = "Catatan itu tersimpan di ( / folder terkait ) halaman pengujian.";
    expect(stripContentlessReportPaths(notAReport)).toBe(notAReport);
  });
});

describe("crossFormatArtifactNote — a deferred offer for an already-delivered format (live 16:25)", () => {
  const live =
    "Udah aku buatin laporan pentestnya buat Mas Naufal! Laporannya sudah siap di report-2026-09-28T09-24-59-073Z.md ya. Kalau nanti perlu di-generate jadi PDF, kabarin aja nanti aku proses.";
  const saved = {
    md: "report-2026-09-28T09-24-59-073Z.md",
    pdf: "report-2026-09-28T09-25-02-746Z.pdf",
  };

  it("catches the live shape: the model offers the PDF while the PDF was already delivered", () => {
    const note = crossFormatArtifactNote(live, { asked: "pdf", savedThisTurn: saved });
    expect(note).not.toBe("");
    expect(note).toContain("sudah dibuat di giliran ini");
  });

  it("catches it when the FACT comes from a real filename the prose itself names", () => {
    // No savedThisTurn: the .pdf named in the text is the fact.
    const withPdfName = "Kalau nanti perlu di-generate jadi PDF, kabarin aja. Sudah ada report-2026-09-28T09-25-02-746Z.pdf kok.";
    expect(crossFormatArtifactNote(withPdfName, { asked: "pdf" })).not.toBe("");
  });

  it("stays SILENT on a genuine offer — nothing was delivered, so the promise is honest", () => {
    const genuine = "Kalau nanti perlu di-generate jadi PDF, kabarin aja nanti aku proses.";
    expect(crossFormatArtifactNote(genuine, { asked: "pdf" })).toBe("");
    expect(crossFormatArtifactNote(genuine, { asked: "pdf", savedThisTurn: { md: "r.md" } })).toBe("");
  });

  it("stays SILENT on ordinary prose that is not an offer", () => {
    expect(crossFormatArtifactNote("Sudah kubuat PDF-nya ya, Manufacturing report-2026-09-28T09-25-02-746Z.pdf", { asked: "pdf", savedThisTurn: saved })).not.toContain("tidak perlu minta izin");
    expect(crossFormatArtifactNote("Ada lagi yang mau dibantu beb?", { asked: "pdf", savedThisTurn: saved })).toBe("");
  });

  it("the offer vocabulary cannot drift: every verb in the list is recognised", () => {
    for (const verb of ["generate", "buat", "bikin", "render", "ekspor", "tulis", "siapkan"]) {
      const t = `Kalau perlu nanti aku ${verb} PDF-nya ya.`;
      expect(DEFERRED_FORMAT_OFFER_RE.test(t)).toBe(true);
    }
  });
});

describe("redactEvidenceForReport — email + Indonesian phone (live 13:18 dump)", () => {
  it("masks the local part of an email but KEEPS the domain", () => {
    const out = redactEvidenceForReport('"email":"admin@kohona.go.id"');
    expect(out).not.toContain("admin@kohona.go.id");
    // The domain is the point of the finding: it proves "addresses on THIS host
    // leaked", so masking it would destroy the evidence.
    expect(out).toContain("@kohona.go.id");
  });

  it("keeps two addresses on the same domain distinguishable", () => {
    const out = redactEvidenceForReport("admin@kohona.go.id dan admin@elsewhere.id");
    expect(out).toContain("a***@kohona.go.id");
    expect(out).toContain("a***@elsewhere.id");
  });

  it("masks an Indonesian phone number", () => {
    const out = redactEvidenceForReport('"hp":"081234567890"');
    expect(out).not.toContain("081234567890");
    expect(out).toMatch(/08\*+90/);
  });

  it("still masks the 16-digit NIK", () => {
    expect(redactEvidenceForReport("3571011234567890")).toBe("357101********90");
  });

  it("LEAVES the XSS proof payload intact (it IS the evidence)", () => {
    const payload = 'POST /api/pengaduan <img src=x onerror=alert(1)> -> 200';
    expect(redactEvidenceForReport(payload)).toBe(payload);
  });

  it("LEAVES status codes, CVSS and durations intact (a 9-digit guard exists for this)", () => {
    const facts = "HTTP/1.1 200 OK, took 1234 ms, id=7, poc_verify 3/3 PASS, CVSS 9.8";
    expect(redactEvidenceForReport(facts)).toBe(facts);
  });

  it("masks a live bearer credential", () => {
    const bearer = redactEvidenceForReport("Authorization: Bearer abc123def456ghi789jkl");
    expect(bearer).not.toContain("abc123def456ghi789jkl");
    expect(bearer).toContain("<REDACTED");
  });

  it("masks a private key block AS A WHOLE (a half-masked key looks redacted and is not)", () => {
    const full = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK1234abcd\nzzz+/==\n-----END RSA PRIVATE KEY-----";
    const out = redactEvidenceForReport(full);
    expect(out).toBe("<REDACTED_PRIVATE_KEY>");
    expect(out).not.toContain("MIIBOgIBAAJBAK1234abcd");
    expect(out).not.toContain("zzz+/==");
  });

  it("leaves a bare key HEADER visible — no body means nothing leaked, and the scanner agrees", () => {
    const headerOnly = "-----BEGIN RSA PRIVATE KEY-----";
    expect(redactEvidenceForReport(headerOnly)).toBe(headerOnly);
    // The residue scanner must not flag it either, or the preflight fails a
    // finding for a string that carries no secret.
    expect(redactorResidues(headerOnly)).toEqual([]);
  });

  it("masks a bare credential assignment but KEEPS the key name (the report must still say WHICH leaked)", () => {
    const out = redactEvidenceForReport("POST /api/login password=hunter2admin sent");
    expect(out).not.toContain("hunter2admin");
    expect(out).toContain("password=");
    expect(out).toContain("<REDACTED>");
  });

  it("redactor and residue scanner now agree on the credential shapes", () => {
    for (const s of [
      "Authorization: Bearer abc123def456ghi789jkl",
      "password: hunter2admin",
      "api_key=sk-live-9f8a7b6c5d4e",
    ]) {
      expect(redactorResidues(s).length).toBeGreaterThan(0);
      expect(redactEvidenceForReport(s)).toMatch(/<REDACTED/);
    }
  });
});
