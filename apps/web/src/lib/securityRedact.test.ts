import { describe, it, expect } from "vitest";
import { redactEvidenceForReport } from "./security";

// Bounty-audit redaction: reports must never carry live credentials/PII while
// dates, times, usernames and XSS payload proof stay intact (unit-tested both
// ways — a redactor that mangles proof is as wrong as one that leaks).
describe("redactEvidenceForReport", () => {
  it("masks mixed-class secrets, 16-digit NIKs and JWTs", () => {
    const out = redactEvidenceForReport(
      "password K0h0na_Sup3rAdmin! leaked, NIK 3571010101010001, tok eyJabc123.def456.ghi789, date 2026-09-26, time 10:15",
    );
    expect(out).not.toContain("K0h0na_Sup3rAdmin");
    expect(out).toContain("<REDACTED>");
    expect(out).toContain("357101********01");
    expect(out).not.toContain("eyJabc123");
    expect(out).toContain("2026-09-26");
    expect(out).toContain("10:15");
  });

  it("masks values of secret-family JSON keys (raw and escaped quotes)", () => {
    const raw = redactEvidenceForReport('{"id":2,"judul":"sekretaris","password":"sekret4ris123","role":"staff"}');
    expect(raw).not.toContain("sekret4ris123");
    expect(raw).toContain('"password":"<REDACTED>"');
    expect(raw).toContain('"judul":"sekretaris"'); // usernames stay

    const escaped = redactEvidenceForReport('\\"isi\\":\\"anggaran2026\\"');
    expect(escaped).not.toContain("anggaran2026");
  });

  it("keeps XSS payload proof intact", () => {
    const payload = '{"nama":"Mia pentest","isi":" mia_xss_marker_miashxlyx7l<img src=x onerror=\\"window.__miaHit=\'mia_xss_miashxlyx7l\'\\">"}';
    const out = redactEvidenceForReport(payload);
    expect(out).toContain("mia_xss_marker_miashxlyx7l");
    expect(out).toContain("<img src=x");
  });
});
