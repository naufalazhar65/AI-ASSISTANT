// Unit tests for workflow_fuzz pure helpers (no network).
import { describe, expect, it } from "vitest";
import { VALUE_PAYLOADS, applyValueMutation, capMutations, classifyMutation, outcomeSignature, sequenceMutations } from "./workflowFuzz";
import type { StepResult } from "./workflowFuzz";
import type { FlowStep } from "./flow";

const step = (name: string, body?: string): FlowStep => ({ name, url: `http://127.0.0.1/x/${name}`, method: "POST", body });
const okRun = (digests: string[]): { ok: boolean; results: StepResult[]; failAt: number; why: string } => ({
  ok: true,
  results: digests.map((d) => ({ status: 200, body: "x", digest: d, ms: 1 })),
  failAt: -1,
  why: "",
});

describe("sequenceMutations", () => {
  const steps = [step("login"), step("pay"), step("receipt")];
  it("produces skip×3 + repeat×3 + reorder×2", () => {
    const m = sequenceMutations(steps);
    expect(m.filter((x) => x.kind === "skip")).toHaveLength(3);
    expect(m.filter((x) => x.kind === "repeat")).toHaveLength(3);
    expect(m.filter((x) => x.kind === "reorder")).toHaveLength(2);
    expect(m).toHaveLength(8);
  });
  it("skip removes exactly the indexed step", () => {
    const m = sequenceMutations(steps).find((x) => x.kind === "skip" && x.at === 1)!;
    expect(m.steps.map((s) => s.name)).toEqual(["login", "receipt"]);
  });
  it("repeat duplicates in place", () => {
    const m = sequenceMutations(steps).find((x) => x.kind === "repeat" && x.at === 1)!;
    expect(m.steps.map((s) => s.name)).toEqual(["login", "pay", "pay", "receipt"]);
  });
  it("reorder swaps adjacent", () => {
    const m = sequenceMutations(steps).find((x) => x.kind === "reorder" && x.at === 0)!;
    expect(m.steps.map((s) => s.name)).toEqual(["pay", "login", "receipt"]);
  });
  it("single-step flow yields no mutations", () => {
    expect(sequenceMutations([step("only")])).toEqual([]);
  });
});

describe("capMutations", () => {
  it("keeps everything when under max", () => {
    const items = [1, 2, 3];
    expect(capMutations(items, 5)).toEqual([1, 2, 3]);
  });
  it("deterministically downsamples with interleaving", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const kept = capMutations(items, 5);
    expect(kept).toHaveLength(5);
    expect(kept).toEqual([0, 4, 8, 12, 16]);
  });
});

describe("value payloads", () => {
  it("patches qty/amount/currency fields", () => {
    const body = '{"qty":2,"amount":10.5,"currency":"IDR"}';
    expect(VALUE_PAYLOADS[0].patch(body)).toContain('"qty":-1');
    expect(VALUE_PAYLOADS[3].patch(body)).toContain('"amount":0');
    expect(VALUE_PAYLOADS[4].patch(body)).toContain('"amount":0.01');
    expect(VALUE_PAYLOADS[5].patch(body)).toContain('"amount":-2');
    expect(VALUE_PAYLOADS[6].patch(body)).toContain('"currency":"XXX"');
  });
  it("applyValueMutation only touches the chosen step", () => {
    const steps = [step("a", '{"qty":1}'), step("b", '{"qty":2}'), step("c", '{"qty":3}')];
    const out = applyValueMutation(steps, 1, 0);
    expect(out[0].body).toContain('"qty":1');
    expect(out[1].body).toContain('"qty":-1');
    expect(out[2].body).toContain('"qty":3');
  });
});

describe("outcomeSignature + classifyMutation", () => {
  it("identical outcomes classify as match", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, okRun(["a", "b"]), "skip");
    expect(v.level).toBe("match");
  });
  it("repeat with identical final digest is a double-processing signal", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, okRun(["a", "b", "b"]), "repeat");
    expect(v.level).toBe("signal");
    expect(v.note).toContain("double-processing");
  });
  it("skip that still completes is a missing-state-validation signal", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, okRun(["b"]), "skip");
    expect(v.level).toBe("signal");
    expect(v.note).toContain("DILEWATI");
  });
  it("reorder that completes is a signal too", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, okRun(["b", "a"]), "reorder");
    expect(v.level).toBe("signal");
  });
  it("different-but-both-ok non-repeat is info (dynamic tokens)", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, okRun(["a", "c"]), "value");
    expect(v.level).toBe("info");
    expect(v.note).toContain("BERBEDA");
  });
  it("mutation rejected at a step is info (control may exist)", () => {
    const base = okRun(["a", "b"]);
    const v = classifyMutation(base, { ok: false, results: [], failAt: 1, why: "status 400 ≠ 200" }, "skip");
    expect(v.level).toBe("info");
    expect(v.note).toContain("ditolak");
  });
  it("both fail = fix the flow first", () => {
    const base = { ok: false, results: [], failAt: 0, why: "x" };
    const v = classifyMutation(base, { ok: false, results: [], failAt: 1, why: "y" }, "skip");
    expect(v.level).toBe("info");
    expect(v.note).toContain("gagal");
  });
  it("outcomeSignature distinguishes failure points", () => {
    expect(outcomeSignature(okRun(["a", "b"]))).not.toBe(outcomeSignature({ ok: false, results: [], failAt: 1 }));
  });
});
