import { describe, it, expect } from "vitest";
import { redactorResidues, RESIDUE_LABELS } from "./redactScan";
import { redactEvidenceForReport } from "./security";

describe("redactorResidues", () => {
  it("is empty for a clean technical evidence block", () => {
    expect(
      redactorResidues(
        "GET /api/dokumen?id=4 -> 200\ncontent-type: application/json\nbody length 1299 bytes\npoc_verify 3/3 PASS"
      )
    ).toEqual([]);
  });

  it("names an email address, which the value-shape redactor never masks", () => {
    expect(redactorResidues("row: ahmad.smith@contoh.co.id | 42")).toContain("email address");
  });

  it("names a phone number", () => {
    expect(redactorResidues("contact 0812-3456-7890")).toContain("phone number");
  });

  it("names a street address", () => {
    expect(redactorResidues("alamat: Jalan Melati No 12,waduk")).toContain("street address");
  });

  it("names a date of birth", () => {
    expect(redactorResidues("tgl lahir: 1990-04-12")).toContain("date of birth");
  });

  it("names a bare credential that the JSON key rule cannot see", () => {
    expect(redactorResidues("POST /login body: user=admin&password=hunter2000")).toContain("bare credential assignment");
  });

  it("names a live bearer credential", () => {
    expect(redactorResidues("Authorization: Bearer abcdef0123456789zzzz")).toContain("live bearer credential");
  });

  it("names a private key block that carries a body", () => {
    const full = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK1234abcd\nzzz+/==\n-----END RSA PRIVATE KEY-----";
    expect(redactorResidues(full)).toContain("private key block");
  });

  it("does NOT name a bare key header (measured 2026-09-28: it leaks no key material)", () => {
    // The redactor deliberately leaves a header-only string visible, so flagging
    // it here would fail a finding for text that carries no secret — the two
    // halves of this module must not disagree.
    expect(redactorResidues("-----BEGIN RSA PRIVATE KEY-----")).toEqual([]);
  });

  it("proves the gap it was written for: the redactor masks the NIK, we still report it", () => {
    // The report redactor DOES mask a 16-digit NIK — so the value never ships.
    // This pair is the point of the module: partial redaction must be visible,
    // not assumed.
    const nik = "3571011234560001";
    expect(redactEvidenceForReport(`nik: ${nik}`)).not.toContain(nik);
    expect(redactorResidues(`nik: ${nik}`)).toContain("NIK / 16-digit national id");
  });
});

describe("RESIDUE_LABELS", () => {
  it("has no duplicate labels", () => {
    expect(new Set(RESIDUE_LABELS).size).toBe(RESIDUE_LABELS.length);
  });
});
