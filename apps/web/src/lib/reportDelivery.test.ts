// reportDelivery.test.ts — markdown delivery mirrors the PDF contract.
//
// Live bug 2026-09-25 11:05: "buatkan report markdown nya" ran only
// `report_generate`, which returns a ~15 KB ephemeral string (8 Discord
// chunks) that the model then claimed was "sudah siap dan tercatat di atas" —
// nothing was above, so the artifact never reached the user.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inlineDeliveryClaimNote, reportProvenanceNote, stripAbsentReportFiles } from "./agent";
import { addFinding, reportPdf, reportSave } from "./security";
import { userDataRoot } from "./users";

const LIVE_REPLY =
  "Laporan lengkap dalam format Markdown untuk pengujian https://target/cek-nik sudah siap dan tercatat di atas Mas Naufal. 🌸";

describe("inlineDeliveryClaimNote", () => {
  it("fires on the live false delivery claim (nothing was above)", () => {
    expect(inlineDeliveryClaimNote(LIVE_REPLY)).toMatch(/tidak ikut terkirim/i);
  });

  it("fires on 'sudah saya lampirkan' / 'lihat di atas' phrasing", () => {
    expect(inlineDeliveryClaimNote("Sudah saya lampirkan di atas ya.")).not.toBe("");
    expect(inlineDeliveryClaimNote("Coba lihat di atas.")).not.toBe("");
    expect(inlineDeliveryClaimNote("Hasilnya sudah aku tulis di atas.")).not.toBe("");
  });

  it("silent when a real delivery receipt exists (path supersedes 'above')", () => {
    expect(inlineDeliveryClaimNote(LIVE_REPLY, { deliveredFile: "md" })).toBe("");
  });

  it("silent when the reply ACTUALLY carries the report body", () => {
    const withBody = `${LIVE_REPLY}\n\n# Laporan Pentest\n- **Kategori**: A01:2025\n- **Evidence**: 200 OK`;
    expect(inlineDeliveryClaimNote(withBody)).toBe("");
  });

  it("silent on ordinary prose that never claims inline delivery", () => {
    expect(inlineDeliveryClaimNote("Aku belum bisa pastikan amannya.")).toBe("");
    expect(inlineDeliveryClaimNote("Pengujian sudah berjalan, tidak ada error.")).toBe("");
  });
});

describe("reportProvenanceNote — store content is not this turn's result", () => {
  // Live 13:16 verbatim claim, over a turn whose only tools were finding_list + six
  // plain GETs (no poc_verify, no finding_add).
  const CLAIM =
    "Pentest sudah selesai dilakukan Mas Naufal. Laporan lengkap mengenai temuan di portal tersebut, termasuk kerentanan kritis seperti SQL Injection dan Broken Access Control, sudah sistem susun menjadi file PDF.";
  const turn = (toolNames: string[]) => [
    { role: "user", content: "full pentest menyeluruh di https://lab.example.com/cek-nik dan buatkan report markdown nya" },
    { role: "assistant", content: null, tool_calls: toolNames.map((n, i) => ({ id: `t${i}`, type: "function" as const, function: { name: n, arguments: "{}" } })) },
    { role: "assistant", content: CLAIM },
  ] as unknown as Parameters<typeof reportProvenanceNote>[0];

  it("discloses that a completion claim came with no recorded finding", () => {
    const note = reportProvenanceNote(turn(["finding_list", "http_request"]), CLAIM);
    expect(note).toMatch(/SUDAH tercatat sebelumnya/);
    expect(note).toMatch(/tidak mencatat temuan baru/);
  });

  it("stays silent when the turn did record a finding", () => {
    expect(reportProvenanceNote(turn(["http_request", "finding_add"]), CLAIM)).toBe("");
  });

  it("stays silent without a completion claim (no nagging on an ordinary report ask)", () => {
    expect(reportProvenanceNote(turn(["http_request"]), "Ini laporannya ya Mas Naufal. 🌸")).toBe("");
  });
});

describe("stripAbsentReportFiles — a fabricated path must never reach the user", () => {
  // Live 2026-09-25 13:16, verbatim: asked for markdown, the reply led with a PDF
  // claim and a filename nothing produces. The note that followed argued with the
  // body while the bogus path stayed in the first paragraph.
  const LIVE_1316 =
    "Laporan lengkap mengenai temuan di portal tersebut, termasuk kerentanan kritis seperti SQL Injection dan Broken Access Control yang membocorkan data sensitif, sudah sistem susun menjadi file PDF. 🌸\n\n" +
    "Laporannya bisa kamu akses di sini: report-6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app.pdf.";
  const none = () => false;

  it("removes a HOSTNAME-fabricated report name too (live drill 15:05: …netlify.app.pdf)", () => {
    const live = "Laporan lengkapnya sudah aku simpan ke PDF di `.data/users/naufal/reports/6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app.pdf`, ya!";
    const out = stripAbsentReportFiles(live, none);
    expect(out).not.toContain("netlify.app.pdf");
    // The strip no longer needs to delete the whole sentence: the format-claim
    // detector now catches "sudah aku simpan ke PDF" (no save happened) and
    // crossFormatArtifactNote appends the honest correction.
  });

  it("crossFormatArtifactNote flags the drill's 'sudah aku simpan ke PDF' claim (no PDF tool ran)", async () => {
    const { crossFormatArtifactNote } = await import("./agent");
    const claim = "Laporan lengkapnya sudah aku simpan ke PDF di `reports/`, ya!";
    expect(crossFormatArtifactNote(claim, { asked: "md", savedThisTurn: { md: "", pdf: "" } })).toMatch(/tidak ada file PDF yang dibuat/);
  });

  it("strips the report- fabricated name (live 13:16)", () => {
    const out = stripAbsentReportFiles(LIVE_1316, none);
    expect(out).not.toContain("report-6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app.pdf");
    expect(out).toContain("bisa kamu akses di sini.");
  });

  it("KEEPS a filename that really exists on disk (a real old report is not a lie)", () => {
    const real = "report-2026-09-25T05-13-11-771Z.pdf";
    const out = stripAbsentReportFiles(`Laporan lama: \`${real}\` — bandingkan ya.`, (n) => n === real);
    expect(out).toContain(real);
  });

  it("strips the report- fabricated name (live 13:16)", () => {
    const out = stripAbsentReportFiles(LIVE_1316, none);
    expect(out).not.toContain("report-6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app.pdf");
    expect(out).toContain("bisa kamu akses di sini.");
  });

  it("removes only the absent one when a real and a fake name sit together", () => {
    const real = "report-2026-09-25T05-13-11-771Z.pdf";
    const fake = "report-cozy-kangaroo-42f2e0.pdf";
    const out = stripAbsentReportFiles(`Real: ${real} — bukan ${fake}.`, (n) => n === real);
    expect(out).toContain(real);
    expect(out).not.toContain(fake);
  });

  it("handles the .md form and backticks", () => {
    const out = stripAbsentReportFiles("Sudah kusimpan: `report-2026-01-01T00-00-00-000Z.md` ya.", none);
    expect(out).not.toContain("report-");
    expect(out).toContain("Sudah kusimpan: ya.");
  });

  it("is fail-open: an unverifiable check leaves every filename alone", () => {
    expect(stripAbsentReportFiles(LIVE_1316, () => true)).toBe(LIVE_1316);
  });
});

describe("turn-delivered receipts + crossFormat store-truth (live 14:09 chain)", () => {
  // Live 14:09: user asked for markdown; the turn ran report_save (wrote the
  // .md) AND the user approved report_pdf (wrote the .pdf). The model's prose
  // named the PDF — correct — yet two notes claimed the opposite: no PDF was
  // made this turn, and the proven finding was "not in the list". The guards
  // could not see what the turn had actually written.
  const LAB = "https://lab.example.com/cek-nik";
  const turn = (tools: Array<[string, Record<string, unknown>]>, toolOut: string, reply: string) => [
    { role: "user", content: `full pentest di ${LAB} dan buatkan report markdown nya` },
    ...tools.map(([n, a], i) => ({ role: "assistant", content: null, tool_calls: [{ id: `t${i}`, type: "function", function: { name: n, arguments: JSON.stringify(a) } }] })),
    { role: "tool", tool_call_id: `t${tools.length - 1}`, content: toolOut },
    { role: "assistant", content: reply },
  ] as never;
  const MD = "report-2026-09-25T07-09-37-607Z.md";
  const PDF = "report-2026-09-25T07-09-54-381Z.pdf";

  it("reportFileFromTurn extracts the .md a report_save tool wrote", async () => {
    const { reportFileFromTurn } = await import("./agent");
    const msgs = turn(
      [["poc_verify", { url: `${LAB}/api/x` }], ["report_save", { target: `${LAB}` }]],
      `✅ PoC STABIL & terkonfirmasi 3/3\n📄 Laporan tersimpan: ${MD}`,
      "Laporan markdown sudah kusimpan ya."
    );
    expect(reportFileFromTurn(msgs, "\\.md")).toBe(MD);
    expect(reportFileFromTurn(msgs, "\\.pdf")).toBe("");
  });

  it("crossFormatArtifactNote never DENIES the quoted format when it was written this turn (live drill 15:53)", async () => {
    const { crossFormatArtifactNote } = await import("./agent");
    // Drill case: only the PDF existed at note time (.md receipt appends LATER)
    // — gating on the REQUESTED format still let "tidak ada file PDF yang
    // dibuat giliran ini" through while report_pdf had just written it.
    const note = crossFormatArtifactNote(
      `Laporan lengkapnya tersedia: ${PDF}`,
      { asked: "md", savedThisTurn: { md: "", pdf: PDF } }
    );
    expect(note).not.toMatch(/tidak ada file PDF yang dibuat/);
    expect(note).toMatch(/memang dibuat giliran ini/);
  });

  it("crossFormatArtifactNote says 'both' when BOTH formats were written this turn", async () => {
    const { crossFormatArtifactNote } = await import("./agent");
    const note = crossFormatArtifactNote(
      `Laporan lengkapnya tersedia: ${PDF}`,
      { asked: "md", savedThisTurn: { md: MD, pdf: PDF } }
    );
    expect(note).not.toMatch(/tidak ada file PDF yang dibuat/);
    expect(note).toMatch(/dua-duanya dibuat giliran ini/);
    expect(note).toContain(MD);
  });

  it("crossFormatArtifactNote keeps the soft 'also valid' note when only the REQUESTED format was saved", async () => {
    const { crossFormatArtifactNote } = await import("./agent");
    const note = crossFormatArtifactNote(
      `Laporan lengkapnya tersedia: ${PDF}`,
      { asked: "md", savedThisTurn: { md: MD, pdf: "" } }
    );
    expect(note).not.toMatch(/tidak ada file PDF yang dibuat/);
    expect(note).toMatch(/dua-duanya valid/);
  });

  it("crossFormatArtifactNote still fires when NOTHING was saved this turn", async () => {
    const { crossFormatArtifactNote } = await import("./agent");
    const note = crossFormatArtifactNote(
      `Laporan lengkapnya tersedia: ${PDF}`,
      { asked: "md", savedThisTurn: { md: "", pdf: "" } }
    );
    expect(note).toMatch(/tidak ada file PDF yang dibuat/);
  });

  it("unrecordedFindingNote is SILENT when the proof URL's host already has an open recorded finding", async () => {
    const { unrecordedFindingNote } = await import("./agent");
    const msgs = turn(
      [["poc_verify", { url: `${LAB}/api/cek-nik?id=1`, times: 3 }]],
      "✅ PoC STABIL & terkonfirmasi 3/3 — GET /api/cek-nik?id=1 → 200",
      "IDOR membocorkan data pribadi, pengujian menyeluruh selesai."
    );
    expect(
      unrecordedFindingNote(msgs, "IDOR membocorkan data pribadi, pengujian menyeluruh selesai.", {
        recordedTargets: [`${LAB}/cek-nik`],
      })
    ).toBe("");
  });

  it("unrecordedFindingNote still fires when the proven host has NO recorded finding", async () => {
    const { unrecordedFindingNote } = await import("./agent");
    const other = "https://other-lab.example.com/api/x";
    const msgs = turn(
      [["poc_verify", { url: `${other}?id=1`, times: 3 }]],
      "✅ PoC STABIL & terkonfirmasi 3/3",
      "IDOR terkonfirmasi, pengujian selesai."
    );
    expect(
      unrecordedFindingNote(msgs, "IDOR terkonfirmasi, pengujian selesai.", {
        recordedTargets: [`${LAB}/cek-nik`],
      })
    ).toMatch(/BELUM masuk daftar/);
  });
});

describe("empty findings are never a deliverable (live 2026-09-25 drill)", () => {
  it("reportSave throws EMPTY_REPORT on a 0-finding target instead of writing a hollow .md", () => {
    const user = `verify_emptymd_${Date.now()}`;
    try {
      expect(() => reportSave(user, { target: "127.0.0.1" })).toThrow(/EMPTY_REPORT/);
      const dir = join(userDataRoot(), user, "reports");
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
      expect(files).toEqual([]);
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  });

  it("reportPdf rejects EMPTY_REPORT on a 0-finding target instead of rendering a hollow PDF", async () => {
    const user = `verify_emptypdf_${Date.now()}`;
    try {
      await expect(reportPdf(user, { target: "127.0.0.1" })).rejects.toThrow(/EMPTY_REPORT/);
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  });

  it("with a recorded finding the deliverable contract still holds (.md + .pdf really land)", async () => {
    const user = `verify_mddelivery_${Date.now()}`;
    try {
      addFinding(user, { title: "IDOR pada /api/cek-nik", severity: "high", cvss: 7.5, target: "https://lab.example/", evidence: "A/B 200" });
      const out = reportSave(user, { target: "https://lab.example/" });
      const file = (out.match(/report-[0-9A-Za-z:.()+_-]+\.md/i) || [])[0] || "";
      expect(file).not.toBe("");
      const body = readFileSync(join(userDataRoot(), user, "reports", file), "utf8");
      expect(body).toContain("IDOR pada /api/cek-nik");
      const pdfOut = await reportPdf(user, { target: "https://lab.example/" });
      const pdfFile = (pdfOut.match(/report-[0-9A-Za-z:.()+_-]+\.pdf/i) || [])[0] || "";
      expect(pdfFile).not.toBe("");
      expect(existsSync(join(userDataRoot(), user, "reports", pdfFile))).toBe(true);
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  }, 30_000);
});
