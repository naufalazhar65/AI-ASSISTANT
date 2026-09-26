import { describe, expect, it } from "vitest";
import {
  EXECUTED_PLACEHOLDER,
  RECEIPT_TOOLS,
  RECEIPT_HEADER,
  URL_HOST_COMPACT_MAX,
  actionReceipt,
  collapsePdfResult,
  compactReceiptUrl,
  mergeReceiptRecords,
  stripReceiptBlock,
} from "./actionReceipt";

const POC_OK = "✅ PoC STABIL & terkonfirmasi 3/3 PASS";
const POC_NEG = "Tidak ada sinyal — bukan klaim aman";
const REFUSED = "Not selected: user did not approve this call.";

describe("RECEIPT_TOOLS", () => {
  it("includes probe tools, deliverables, and real-world effectors", () => {
    for (const t of ["poc_verify", "finding_add", "report_pdf", "http_request", "exec_write", "cdp_proxy"]) {
      expect(RECEIPT_TOOLS.has(t)).toBe(true);
    }
  });
  it("excludes pure store reads and chat helpers", () => {
    for (const t of ["finding_list", "hunt_log", "web_search", "remind_me", "mood_log"]) {
      expect(RECEIPT_TOOLS.has(t)).toBe(false);
    }
  });
  it("includes endpoint-touching reads (live 2026-09-25 drill: fetch_url ran but never rendered)", () => {
    for (const t of ["fetch_url", "web_audit", "csp_audit", "cors_audit", "browser_open", "cdp_eval"]) {
      expect(RECEIPT_TOOLS.has(t)).toBe(true);
    }
  });
});

describe("stripReceiptBlock", () => {
  it("removes the system receipt so daily memory never self-primes RAG recall", () => {
    const receipt = actionReceipt([{ name: "http_request", args: JSON.stringify({ url: "https://lab/x" }), result: "200 OK" }]);
    expect(receipt).toContain(RECEIPT_HEADER);
    const text = `Nih ringkasannya ya beb 🌸${receipt}`;
    expect(stripReceiptBlock(text)).toBe("Nih ringkasannya ya beb 🌸");
  });
  it("leaves text without a receipt untouched", () => {
    const plain = "Aku sudah jalankan poc_verify dan hasilnya stabil.";
    expect(stripReceiptBlock(plain)).toBe(plain);
    expect(stripReceiptBlock("")).toBe("");
  });
  it("keeps a prose MENTION of the header phrase (only the appended block is stripped)", () => {
    const quoted = "Ini daftar aksinya ya: Aksi yang benar-benar dijalankan: tiga probe.";
    expect(stripReceiptBlock(quoted)).toBe(quoted);
  });
});

describe("actionReceipt", () => {
  it("renders one line per executed action tool with a target digest", () => {
    const out = actionReceipt([
      { name: "poc_verify", args: JSON.stringify({ url: "https://lab.example/api/cek-nik?id=1" }), result: POC_OK },
    ]);
    expect(out).toContain("Aksi yang benar-benar dijalankan:");
    expect(out).toContain("poc_verify → https://lab.example/api/cek-nik?id=1");
    expect(out).toContain(POC_OK);
  });

  it("skips refusals, non-receipt tools, and empty results", () => {
    const out = actionReceipt([
      { name: "poc_verify", args: "{}", result: REFUSED },
      { name: "finding_list", args: "{}", result: "6 temuan" },
      { name: "http_request", args: "{}", result: "  " },
    ]);
    expect(out).toBe("");
  });

  it("dedupes identical name+args executions", () => {
    const rec = { name: "http_request", args: JSON.stringify({ url: "https://lab.example/a" }), result: "200 OK" };
    const out = actionReceipt([rec, rec, { ...rec, result: "200 OK (retry)" }]);
    const lines = out.split("\n").filter((l) => l.startsWith("⚙️"));
    expect(lines.length).toBe(1);
  });

  it("summarizes long tool results to one bounded line", () => {
    const out = actionReceipt([{ name: "finding_add", args: "{}", result: `${"y".repeat(300)}\nsecond line` }]);
    expect(out).not.toContain("y".repeat(300));
    expect(out).toContain("…");
  });

  it("tags prior-turn records", () => {
    const out = actionReceipt([{ name: "pentest_scan", args: "{}", result: "done", prior: true }]);
    expect(out).toContain("(turn sebelumnya)");
  });

  it("drops malformed names — receipt lines are the system's monopoly (live 19:30: model imitated a degenerate '⚙️ :' line)", () => {
    const out = actionReceipt([
      { name: "", args: "{}", result: EXECUTED_PLACEHOLDER },
      { name: "Some Random Text", args: "{}", result: "x" },
      { name: "http_request", args: "{}", result: "200 OK" },
    ]);
    expect(out).not.toMatch(/⚙️\s*:/);
    expect(out).toContain("http_request");
  });

  it("returns empty for no records", () => {
    expect(actionReceipt([])).toBe("");
  });

  it("caps at 8 lines with an overflow note", () => {
    const recs = Array.from({ length: 12 }, (_, i) => ({
      name: "http_request",
      args: JSON.stringify({ url: `https://lab.example/${i}` }),
      result: "200 OK",
    }));
    const out = actionReceipt(recs);
    expect(out).toContain("+4 aksi lainnya");
  });
});

describe("mergeReceiptRecords", () => {
  it("dedupes by name+args and upgrades a placeholder result with the real one", () => {
    const args = JSON.stringify({ url: "https://lab.example/x" });
    const merged = mergeReceiptRecords(
      [{ name: "poc_verify", args, result: EXECUTED_PLACEHOLDER, prior: true }],
      [{ name: "poc_verify", args, result: POC_OK }],
    );
    expect(merged.length).toBe(1);
    expect(merged[0].result).toBe(POC_OK);
    expect(merged[0].prior).toBe(true);
  });

  it("keeps distinct args as distinct records", () => {
    const merged = mergeReceiptRecords(
      [{ name: "http_request", args: JSON.stringify({ url: "https://a/x" }), result: "200" }],
      [{ name: "http_request", args: JSON.stringify({ url: "https://a/y" }), result: "200" }],
    );
    expect(merged.length).toBe(2);
  });

  it("drops stale prior records past the 10-minute window (live 19:30: 3.5h-old probe surfaced as 'previous turn')", () => {
    const old = new Date(Date.now() - 3.5 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 30 * 1000);
    const merged = mergeReceiptRecords([], [
      { name: "http_request", args: "{}", result: EXECUTED_PLACEHOLDER, prior: true, at: old },
      { name: "poc_verify", args: "{}", result: EXECUTED_PLACEHOLDER, prior: true, at: fresh },
    ]);
    expect(merged.some((r) => r.name === "http_request")).toBe(false);
    expect(merged.some((r) => r.name === "poc_verify")).toBe(true);
  });
});

describe("compactReceiptUrl (tidiness 2026-09-26: same lab URL 4× per receipt ≈ 28 visual lines on mobile)", () => {
  const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

  it("FIRE: a long URL (>40) renders as pathname+query, not the host — receipt stays one line", () => {
    expect(`${LAB}/cek-nik`.length).toBeGreaterThan(URL_HOST_COMPACT_MAX);
    expect(compactReceiptUrl(`${LAB}/cek-nik?id=1`)).toBe("/cek-nik?id=1");
    expect(compactReceiptUrl(`${LAB}/cek-nik`)).toBe("/cek-nik");
  });

  it("FIRE: root-only long URL falls back to the bare origin host", () => {
    expect(compactReceiptUrl(`${LAB}/`)).toBe("6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app");
  });

  it("SILENT: short URLs stay verbatim (verify.ts digest assertion relies on the full URL)", () => {
    expect(compactReceiptUrl("https://lab.example/api/cek-nik?id=1")).toBe("https://lab.example/api/cek-nik?id=1");
    expect(compactReceiptUrl("")).toBe("");
  });

  it("end-to-end: the live 10:10 receipt no longer repeats the 56-char lab host 4×", () => {
    const out = actionReceipt([
      { name: "report_pdf", args: JSON.stringify({ target: `${LAB}/cek-nik` }), result: `📄 PDF disimpan: /home/u/ai-assistant/apps/web/.data/users/naufalazhar652952/reports/report-2026-09-26T03-10-16-897Z.pdf` },
      { name: "http_request", args: JSON.stringify({ url: `${LAB}/cek-nik` }), result: "(dieksekusi)", prior: true },
      { name: "web_audit", args: JSON.stringify({ url: `${LAB}/cek-nik` }), result: "(dieksekusi)", prior: true },
      { name: "js_mine", args: JSON.stringify({ url: `${LAB}/cek-nik` }), result: "(dieksekusi)", prior: true },
    ]);
    expect((out.match(/cozy-kangaroo/g) || []).length).toBe(0); // host gone entirely — every arg carried a path, the PDF result is a bare filename
    expect(out).toContain("⚙️ report_pdf → /cek-nik: report-2026-09-26T03-10-16-897Z.pdf");
    expect(out).toContain("⚙️ http_request → /cek-nik (turn sebelumnya)");
  });

  it("FIRE: long URLs inside result summaries compact too — no dead '→ …' tails (live 12:40 shape)", () => {
    const out = actionReceipt([
      { name: "http_request", args: JSON.stringify({ url: `${LAB}/api/cek-nik?id=1` }), result: `🌐 HTTP GET ${LAB}/api/cek-nik?id=1 -> {"id":1,"nama":"..."}` },
    ]);
    expect(out).not.toContain("cozy-kangaroo");
    expect(out).toContain("🌐 HTTP GET /api/cek-nik?id=1 -> {");
  });

  it("SILENT: short URLs inside results stay verbatim", () => {
    const out = actionReceipt([
      { name: "http_request", args: JSON.stringify({ url: "https://lab.example/x" }), result: "🌐 HTTP GET https://lab.example/x -> 200 OK" },
    ]);
    expect(out).toContain("https://lab.example/x");
  });
});

describe("collapsePdfResult (tidiness 2026-09-26: absolute PDF path twice — narration + receipt — both truncated)", () => {
  it("FIRE: tool result keeps only the filename", () => {
    expect(collapsePdfResult("📄 PDF disimpan: /home/u/ai-assistant/apps/web/.data/users/naufalazhar652952/reports/report-2026-09-26T03-10-16-897Z.pdf"))
      .toBe("report-2026-09-26T03-10-16-897Z.pdf");
  });

  it("FIRE: a path ALREADY truncated mid-way degrades to a short fragment, never a giant path", () => {
    const out = collapsePdfResult("📄 PDF disimpan: /home/u/ai-assistant/apps/web/.data/users/naufalazhar…");
    expect(out).toBe("naufalazhar…");
    expect(out.length).toBeLessThan(20);
  });

  it("SILENT: non-path results come back unchanged (never fabricates)", () => {
    expect(collapsePdfResult("✅ PoC STABIL & terkonfirmasi 3/3 PASS")).toBe("✅ PoC STABIL & terkonfirmasi 3/3 PASS");
    expect(collapsePdfResult("")).toBe("");
  });

  it("end-to-end: report_pdf receipt line shows the bare filename", () => {
    const out = actionReceipt([
      { name: "report_pdf", args: "{}", result: "📄 PDF disimpan: /home/u/reports/report-2026-09-26T03-10-16-897Z.pdf" },
    ]);
    expect(out).toContain("⚙️ report_pdf: report-2026-09-26T03-10-16-897Z.pdf");
    expect(out).not.toContain("/home/u");
  });
});
