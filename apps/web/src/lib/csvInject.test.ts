// csvInject.test.ts — pure helpers of the csv_inject prover.
import { describe, it, expect } from "vitest";
import { csvMarker, classifyExport, FORMULA_PAYLOADS, EXPORT_PATHS } from "./csvInject";

describe("csvMarker", () => {
  it("is deterministic and mia-shaped", () => {
    expect(csvMarker("abc")).toBe(csvMarker("abc"));
    expect(csvMarker("abc")).toMatch(/^mia[0-9]{6}$/);
  });
  it("differs across seeds", () => {
    expect(csvMarker("a")).not.toBe(csvMarker("b"));
  });
});

describe("classifyExport", () => {
  const mk = "mia123456";
  const dde = `=cmd|' /C calc'!A0`;

  it("flags a raw formula riding in a csv artifact", () => {
    const body = `id,name\n1,x\n2,${mk}|${dde}\n`;
    const v = classifyExport(body, mk, "text/csv", 'attachment; filename="users.csv"');
    expect(v.verdict).toBe("raw");
    expect(v.spreadsheet).toBe(true);
  });

  it("honors a sanitized export (defense works)", () => {
    const body = `id,name\n2,'${mk}|${dde}\n`;
    const v = classifyExport(body, mk, "text/csv", undefined);
    expect(v.verdict).toBe("sanitized");
  });

  it("is honest when the marker never reaches the export", () => {
    const v = classifyExport("id,name\n1,x\n", mk, "text/csv", undefined);
    expect(v.verdict).toBe("absent");
  });

  it("detects spreadsheet shape from content-type alone", () => {
    const v = classifyExport(`${mk}|x`, mk, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", undefined);
    expect(v.spreadsheet).toBe(true);
  });

  it("non-spreadsheet raw still reports raw (weak evidence)", () => {
    const v = classifyExport(`hello ${mk}|=cmd`, mk, "text/html", undefined);
    expect(v.verdict).toBe("raw");
    expect(v.spreadsheet).toBe(false);
  });
});

describe("FORMULA_PAYLOADS / EXPORT_PATHS", () => {
  it("cover the classic interpreters", () => {
    const kinds = FORMULA_PAYLOADS.map((f) => f.kind).join(" ");
    expect(kinds).toContain("DDE");
    expect(kinds).toContain("HYPERLINK");
    expect(kinds).toContain("tab-prefix");
    expect(FORMULA_PAYLOADS.every((f) => f.p.length > 5)).toBe(true);
  });
  it("probe bounded common export paths", () => {
    expect(EXPORT_PATHS.length).toBeGreaterThan(4);
    expect(EXPORT_PATHS.length).toBeLessThan(12);
    expect(EXPORT_PATHS.every((p) => p.startsWith("/"))).toBe(true);
  });
});
