// idorEnumeration.test.ts — replay of the live 12:02 turn, both residual gaps.
//
// (a) The model ran ?id=1, ?id=2, ?id=3 — the canonical IDOR test — yet the
//     guard said "/cek-nik baru dibaca, belum diuji". For IDOR the changing id
//     IS the payload, so a marker-grep rule can never see it.
// (b) The user asked for markdown, the .md was really delivered, and the model
//     still wrote "format PDF sudah tersedia" + "PDF laporan sudah tersimpan" —
//     no PDF existed, and the old filename-only check could not see it.
import { describe, expect, it } from "vitest";
import { crossFormatArtifactNote, endpointTriageNote, isEnumerationProbe } from "./agent";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** The exact 12:02 tool sequence from the audit log. */
function live1202() {
  return [
    { role: "user", content: `full pentest menyeluruh di ${LAB}/cek-nik dan buatkan report markdown nya` },
    { role: "assistant", content: null, tool_calls: [call("a", "http_request", { url: `${LAB}/api/cek-nik?id=1234567890123456`, method: "GET" })] },
    { role: "tool", tool_call_id: "a", content: "404" },
    { role: "assistant", content: null, tool_calls: [call("b", "http_request", { url: `${LAB}/api/cek-nik?id=1`, method: "GET" })] },
    { role: "tool", tool_call_id: "b", content: '{"nik":"35710…"}' },
    { role: "assistant", content: null, tool_calls: [call("c", "http_request", { url: `${LAB}/api/cek-nik?id=2`, method: "GET" })] },
    { role: "tool", tool_call_id: "c", content: '{"nik":"35720…"}' },
    { role: "assistant", content: null, tool_calls: [call("d", "http_request", { url: `${LAB}/api/cek-nik?id=3`, method: "GET" })] },
    { role: "tool", tool_call_id: "d", content: '{"nik":"35730…"}' },
    {
      role: "assistant",
      content:
        "Aku sudah menguji endpoint /api/cek-nik dan mengonfirmasi bahwa data penduduk bisa diakses secara sekuensial tanpa autentikasi.",
    },
  ] as never;
}

describe("isEnumerationProbe", () => {
  it("true for sequential-ID enumeration (the IDOR payload IS the value)", () => {
    expect(
      isEnumerationProbe([
        { url: `${LAB}/api/cek-nik?id=1` },
        { url: `${LAB}/api/cek-nik?id=2` },
        { url: `${LAB}/api/cek-nik?id=3` },
      ])
    ).toBe(true);
  });
  it("false for repeated IDENTICAL calls (baseline/polling is not a test)", () => {
    expect(isEnumerationProbe([{ url: "X" }, { url: "X" }])).toBe(false);
  });
  it("false for a single call", () => {
    expect(isEnumerationProbe([{ url: "X" }])).toBe(false);
  });
  it("ignores cosmetic arg differences (method default is not a new test)", () => {
    expect(isEnumerationProbe([{ url: "X" }, { url: "X", method: "GET" }])).toBe(false);
  });
});

describe("endpointTriageNote — IDOR enumeration is testing (live 12:02)", () => {
  it("no longer tells the user it was 'belum diuji'", () => {
    const note = endpointTriageNote(
      live1202(),
      "Aku sudah menguji endpoint /api/cek-nik dan mengonfirmasi akses sekuensial tanpa autentikasi."
    );
    expect(note).toBe("");
  });

  it("STILL fires when the turn only made one read (no enumeration)", () => {
    const msgs = [
      { role: "user", content: `uji ${LAB}/cek-nik` },
      { role: "assistant", content: null, tool_calls: [call("a", "http_request", { url: `${LAB}/api/cek-nik?id=1` })] },
      { role: "tool", tool_call_id: "a", content: "200" },
      { role: "assistant", content: "Endpoint sudah aman, pengujian selesai." },
    ] as never;
    const note = endpointTriageNote(msgs, "Endpoint sudah aman, pengujian selesai.");
    expect(note).not.toBe("");
    expect(note).toContain("/cek-nik");
    expect(note).toMatch(/hanya dari membaca halaman/i);
  });

  it("STILL fires on the zero-contact case (no read at all)", () => {
    const msgs = [
      { role: "user", content: `uji ${LAB}/cek-nik` },
      { role: "assistant", content: null, tool_calls: [call("a", "finding_list", { target: `${LAB}/cek-nik` })] },
      { role: "tool", tool_call_id: "a", content: "6 temuan" },
      { role: "assistant", content: "Sudah selesai menguji dan aman." },
    ] as never;
    expect(endpointTriageNote(msgs, "Sudah selesai menguji dan aman.")).toMatch(/tidak menyentuh/i);
  });
});

describe("crossFormatArtifactNote — bare format claims (live 12:02)", () => {
  it("flags 'format PDF sudah tersedia' when markdown was asked", () => {
    const live =
      "Laporan lengkap dalam format PDF sudah tersedia. PDF laporan sudah tersimpan otomatis ya.";
    const note = crossFormatArtifactNote(live, { asked: "md" });
    expect(note).toMatch(/yang kamu minta Markdown/i);
    expect(note).toMatch(/tidak ada file PDF yang dibuat/i);
  });

  it("flags 'dalam format markdown' when PDF was asked", () => {
    expect(crossFormatArtifactNote("sudah kusimpan dalam format markdown", { asked: "pdf" })).not.toBe("");
  });

  it("silent when the reply names BOTH formats (the .md was really delivered)", () => {
    const both = "format markdown sudah disimpan, dan saya buatkan juga versi PDF-nya.";
    expect(crossFormatArtifactNote(both, { asked: "md" })).toBe("");
  });

  it("silent when only the requested format is claimed", () => {
    expect(crossFormatArtifactNote("format markdown sudah tersedia", { asked: "md" })).toBe("");
  });

  it("silent when nothing format-related is claimed", () => {
    expect(crossFormatArtifactNote("PDF dan markdown sama-sama enak dibaca ya", { asked: "md" })).toBe("");
  });
});
