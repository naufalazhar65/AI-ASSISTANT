import { describe, expect, it } from "vitest";
import { idProseStrength, indonesianProseField } from "./findingLanguage";

const ID_IMPACT =
  "Penyerang tanpa autentikasi dapat membaca SELURUH basis data: kredensial pegawai dalam bentuk plaintext, data kependudukan, dokumen internal, dan pengaduan. Kredensial admin yang bocor memungkinkan pengambilalihan penuh portal.";

const EN_IMPACT =
  "An unauthenticated attacker can read the ENTIRE database: employee credentials in plaintext, resident records, internal documents, and complaints. The leaked admin credentials enable full portal takeover.";

describe("idProseStrength", () => {
  it("flags Indonesian finding prose", () => {
    const r = idProseStrength(ID_IMPACT);
    expect(r.indonesian).toBe(true);
    expect(r.markers).toBeGreaterThanOrEqual(5);
  });

  it("passes English finding prose (even with quoted Indonesian payloads)", () => {
    expect(indonesianProseField(EN_IMPACT)).toBe(false);
    // Quoted Indonesian evidence strings + local field names must not trip it.
    const mixed =
      'GET /api/dokumen?id=4 + header "x-user-role: admin" → HTTP 200. The response body says "Dokumen ini bersifat internal. Login sebagai pegawai untuk mengakses." and the isi field contains the notulen payload. poc_verify 3/3 PASS (deterministic 200).';
    expect(indonesianProseField(mixed)).toBe(false);
  });

  it("is honest on short/empty fields", () => {
    expect(indonesianProseField("")).toBe(false);
    expect(indonesianProseField("Missing authorization check on endpoint.")).toBe(false);
    // Short but clearly Indonesian: 3 markers + high density.
    expect(indonesianProseField("Penyerang dapat membaca data pengguna tanpa otorisasi")).toBe(true);
  });
});
