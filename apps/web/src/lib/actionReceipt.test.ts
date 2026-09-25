import { describe, expect, it } from "vitest";
import { EXECUTED_PLACEHOLDER, RECEIPT_TOOLS, RECEIPT_HEADER, actionReceipt, mergeReceiptRecords, stripReceiptBlock } from "./actionReceipt";

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
