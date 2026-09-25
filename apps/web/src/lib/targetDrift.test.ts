// targetDrift.test.ts — disclosure of a silently-substituted target, and
// cross-format artifact honesty.
//
// Live 2026-09-25 11:13: the user wrote a TRUNCATED url
// (https://6a90...netlify.app/cek-nik). The model substituted the full host
// from chat history, ran finding_list/report_generate against it, handed over a
// .md — and pointed at a PDF from 11 minutes earlier as "the report". Nothing in
// the reply disclosed the substitution.
import { describe, expect, it } from "vitest";
import { crossFormatArtifactNote, isMalformedTargetUrl, targetDriftNote } from "./agent";

const FULL = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const TRUNC = "https://6a90...netlify.app/cek-nik";
const type = (role: string, content: string | null, calls?: unknown) => ({ role, content, tool_calls: calls });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

describe("isMalformedTargetUrl", () => {
  it("flags the truncated host (empty DNS labels) that new URL() accepts", () => {
    expect(isMalformedTargetUrl(TRUNC)).toBe(true);
  });
  it("accepts real hosts", () => {
    expect(isMalformedTargetUrl(`${FULL}/cek-nik`)).toBe(false);
    expect(isMalformedTargetUrl("https://example.com")).toBe(false);
    expect(isMalformedTargetUrl("http://127.0.0.1:4010/api/x")).toBe(false);
  });
});

describe("targetDriftNote", () => {
  it("discloses the substitution on the live turn", () => {
    const msgs = [
      type("user", `full pentest di ${TRUNC} dan buatkan report markdown nya`),
      type("assistant", null, [call("a", "finding_list", { target: `${FULL}/cek-nik` })]),
      type("tool", "6 temuan"),
      type("assistant", "Laporan sudah siap."),
    ] as never;
    const note = targetDriftNote(msgs, "Laporan sudah siap.");
    expect(note).toMatch(/terpotong/i);
    expect(note).toContain("6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app");
  });

  it("discloses a plain wrong-host substitution too", () => {
    const msgs = [
      type("user", `uji di ${FULL}/cek-nik`),
      type("assistant", null, [call("a", "finding_list", { target: "https://evil.example/x" })]),
      type("tool", "…"),
      type("assistant", "Sudah diuji."),
    ] as never;
    expect(targetDriftNote(msgs, "Sudah diuji.")).toMatch(/BUKAN/i);
  });

  it("silent when the tool target IS what the user wrote", () => {
    const msgs = [
      type("user", `uji di ${FULL}/cek-nik`),
      type("assistant", null, [call("a", "http_request", { url: `${FULL}/cek-nik` })]),
      type("tool", "200"),
      type("assistant", "Sudah diuji."),
    ] as never;
    expect(targetDriftNote(msgs, "Sudah diuji.")).toBe("");
  });

  it("silent when the tool target is a PARENT/CHILD of the asked host", () => {
    // example.com → app.example.com is the same site; testing it is not drift.
    const msgs = [
      type("user", "uji di https://example.com/x"),
      type("assistant", null, [call("a", "http_request", { url: "https://app.example.com/x" })]),
      type("tool", "200"),
      type("assistant", "ok"),
    ] as never;
    expect(targetDriftNote(msgs, "ok")).toBe("");
  });

  it("FLAGS sibling subdomains — a different site is still a different target", () => {
    // app.example.com → api.example.com. Shared-hosting domains (netlify.app,
    // github.io) make sibling-subdomain equivalence actively dangerous, so the
    // guard must NOT treat a shared registrable domain as "same target".
    const msgs = [
      type("user", "uji di https://app.example.com/x"),
      type("assistant", null, [call("a", "http_request", { url: "https://api.example.com/x" })]),
      type("tool", "200"),
      type("assistant", "ok"),
    ] as never;
    expect(targetDriftNote(msgs, "ok")).toMatch(/BUKAN/i);
  });

  it("silent when no URL was asked at all", () => {
    const msgs = [type("user", "cek laporan"), type("assistant", "ok")] as never;
    expect(targetDriftNote(msgs, "ok")).toBe("");
  });

  it("SILENT when the foreign URL is only a citation inside finding_add args (live 13:50 false positive)", () => {
    // Live: the lab was probed 9× (all http_request url args = lab), one
    // finding carried an owasp.org REFERENCE link — the guard mined it as
    // "the tested target" and accused drift on a fully on-target turn.
    const msgs = [
      type("user", `full pentest di ${FULL}/cek-nik dan buatkan report markdown nya`),
      type("assistant", null, [call("a", "http_request", { url: `${FULL}/api/cek-nik?id=1` })]),
      type("tool", "200"),
      type("assistant", null, [
        call("b", "finding_add", {
          title: "PII Exposure via IDOR",
          target: `${FULL}/cek-nik`,
          references: "https://owasp.org/www-project-top-ten",
        }),
      ]),
      type("tool", "finding tersimpan"),
      type("assistant", "Laporan markdown sudah kusimpan."),
    ] as never;
    expect(targetDriftNote(msgs, "Laporan markdown sudah kusimpan.")).toBe("");
  });

  it("still fires when tools genuinely ran on a DIFFERENT host than the ask", () => {
    const msgs = [
      type("user", `uji di ${FULL}/cek-nik`),
      type("assistant", null, [call("a", "http_request", { url: "https://other-lab.example.com/api/x" })]),
      type("tool", "200"),
      type("assistant", "Sudah diuji."),
    ] as never;
    expect(targetDriftNote(msgs, "Sudah diuji.")).toMatch(/BUKAN/i);
  });

  it("silent when the asked host appears among several url args (lab + OAST beacon)", () => {
    // An oast callback beacon is by design a foreign host; the lab WAS tested.
    const msgs = [
      type("user", `uji ssrf di ${FULL}/api/fetch`),
      type("assistant", null, [
        call("a", "blind_ssrf", { url: `${FULL}/api/fetch`, callback: "https://abc123.oast.pro" }),
      ]),
      type("tool", "probes sent"),
      type("assistant", "Probe OOB terkirim."),
    ] as never;
    expect(targetDriftNote(msgs, "Probe OOB terkirim.")).toBe("");
  });

  it("ignores malformed (non-JSON) tool args instead of regex-mining them", () => {
    const msgs = [
      type("user", `uji di ${FULL}/cek-nik`),
      type("assistant", null, [
        { id: "a", type: "function", function: { name: "web_search", arguments: "not json https://evil.example/x" } },
      ]),
      type("tool", "ok"),
      type("assistant", "selesai"),
    ] as never;
    expect(targetDriftNote(msgs, "selesai")).toBe("");
  });
});

describe("crossFormatArtifactNote", () => {
  it("flags a PDF pointer answering a markdown request (the live 11:13 case)", () => {
    // Only the PDF was named — the .md the user asked for never appeared.
    const live = "PDF laporannya bisa diakses di: ~/reports/report-2026-09-25T04-02-24-073Z.pdf";
    const note = crossFormatArtifactNote(live, { asked: "md" });
    expect(note).toMatch(/yang kamu minta Markdown/i);
    expect(note).toContain("04-02-24-073Z.pdf");
  });

  it("SILENT when both formats are delivered (live 11:29 — a false positive this fixed)", () => {
    const both = `📄 Markdown: ~/reports/report-2026-09-25T04-29-27-782Z.md\n📄 PDF: ~/reports/report-2026-09-25T04-29-40-463Z.pdf`;
    expect(crossFormatArtifactNote(both, { asked: "md" })).toBe("");
    expect(crossFormatArtifactNote(both, { asked: "pdf" })).toBe("");
  });

  it("never quotes the requested file as the 'wrong' one", () => {
    // The regression: guard matched `.pdf` but quoted the FIRST report file,
    // which was the correct .md — producing "you asked Markdown but I named
    // report-….md, which is not the deliverable". Self-contradictory.
    const both = `Markdown: report-A.md\nPDF: report-B.pdf`;
    const note = crossFormatArtifactNote(both, { asked: "md" });
    expect(note).toBe("");
  });

  it("preserves the file's exact casing in the note (a receipt must match disk)", () => {
    const live = "PDF-nya di ~/reports/report-2026-09-25T04-02-24-073Z.pdf";
    const note = crossFormatArtifactNote(live, { asked: "md" });
    expect(note).toContain("report-2026-09-25T04-02-24-073Z.pdf"); // T/Z uppercase preserved
  });

  it("flags a .md pointer answering a PDF request", () => {
    expect(crossFormatArtifactNote("sudah kusimpan: report-x.md", { asked: "pdf" })).toMatch(/yang kamu minta PDF/i);
  });

  it("silent when only the requested format is mentioned", () => {
    expect(crossFormatArtifactNote("(📄 Markdown-nya sudah kusimpan: report-x.md)", { asked: "md" })).toBe("");
    expect(crossFormatArtifactNote("(📎 PDF-nya sudah kubuat: report-x.pdf)", { asked: "pdf" })).toBe("");
  });

  it("silent when no report format was requested", () => {
    expect(crossFormatArtifactNote("lihat report-x.pdf lama", { asked: "" })).toBe("");
  });
});
