// CVSS v4.0 base score (FIRST specification, https://www.first.org/cvss/v4.0/).
//
// Hand-rolled like the existing CVSS v3.1 scorer in security.ts, so findings can
// carry a v4 vector without adding a runtime dependency. The MacroVector lookup
// data lives in cvssV4Data.ts (standard values). Correctness is pinned by
// tests/verify against published anchor vectors.
//
// Base-score only: threat (E) and environmental (CR/IR/AR/MSI/MSA) metrics are
// treated as their X defaults, which is what the spec's base metric group means.

import { CVSS4_LOOKUP, CVSS4_MAX_COMPOSED, CVSS4_MAX_SEVERITY } from "./cvssV4Data";

/** Allowed values per base metric. */
const BASE_METRICS: Record<string, string[]> = {
  AV: ["N", "A", "L", "P"],
  AC: ["L", "H"],
  AT: ["N", "P"],
  PR: ["N", "L", "H"],
  UI: ["N", "P", "A"],
  VC: ["H", "L", "N"],
  VI: ["H", "L", "N"],
  VA: ["H", "L", "N"],
  SC: ["H", "L", "N"],
  SI: ["H", "L", "N"],
  SA: ["H", "L", "N"],
};

/** Metric level → depth, used for the severity distance inside a MacroVector. */
const LEVELS: Record<string, Record<string, number>> = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 },
  PR: { N: 0, L: 0.1, H: 0.2 },
  UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 },
  AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 },
  VI: { H: 0, L: 0.1, N: 0.2 },
  VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 },
  SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 },
  IR: { H: 0, M: 0.1, L: 0.2 },
  AR: { H: 0, M: 0.1, L: 0.2 },
};

/** Undefined threat/environmental metrics take the spec's worst case. */
const WORST_CASE: Record<string, string> = { E: "A", CR: "H", IR: "H", AR: "H" };

/** Parse and validate a `CVSS:4.0/…` base vector. Throws with a readable reason. */
export function parseV4Vector(vector: string): Record<string, string> {
  const raw = (vector || "").trim().toUpperCase();
  if (!raw.startsWith("CVSS:4.0/")) throw new Error("vektor harus diawali CVSS:4.0/");
  const sel: Record<string, string> = { ...WORST_CASE };
  for (const part of raw.split("/").slice(1)) {
    if (!part) continue;
    const idx = part.indexOf(":");
    if (idx < 0) throw new Error(`metrik "${part}" tak punya nilai`);
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key in sel) throw new Error(`metrik ganda: ${key}`);
    sel[key] = value;
  }
  for (const [key, allowed] of Object.entries(BASE_METRICS)) {
    const v = sel[key];
    if (!v) throw new Error(`metrik wajib kurang: ${key}`);
    if (!allowed.includes(v)) throw new Error(`nilai ${key}:${v} tak valid (pilih ${allowed.join("/")})`);
  }
  return sel;
}

/** Value of a metric with X-defaults applied (spec §8.1 / reference behaviour). */
function metric(sel: Record<string, string>, key: string): string | undefined {
  const modified = sel[`M${key}`];
  if (modified && modified !== "X") return modified;
  const value = sel[key];
  if (value === undefined || value === "X") return WORST_CASE[key] ?? value;
  return value;
}

/** The 6-digit MacroVector (EQ1…EQ6) for a parsed vector. */
export function cvss4MacroVector(sel: Record<string, string>): string {
  const v = (k: string) => metric(sel, k);
  const eq1 =
    v("AV") === "N" && v("PR") === "N" && v("UI") === "N"
      ? 0
      : (v("AV") === "N" || v("PR") === "N" || v("UI") === "N") && v("AV") !== "P"
        ? 1
        : 2;
  const eq2 = v("AC") === "L" && v("AT") === "N" ? 0 : 1;
  const eq3 = v("VC") === "H" && v("VI") === "H" ? 0 : v("VC") === "H" || v("VI") === "H" || v("VA") === "H" ? 1 : 2;
  const eq4 =
    v("MSI") === "S" || v("MSA") === "S"
      ? 0
      : v("SC") === "H" || v("SI") === "H" || v("SA") === "H"
        ? 1
        : 2;
  const eq5 = v("E") === "A" ? 0 : v("E") === "P" ? 1 : 2;
  const eq6 =
    (v("CR") === "H" && v("VC") === "H") || (v("IR") === "H" && v("VI") === "H") || (v("AR") === "H" && v("VA") === "H") ? 0 : 1;
  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`;
}

type MaxComposed = Record<string, Record<string, unknown>>;

/** Read `metric:value` out of a composed "/"-joined max vector. */
function extractMetric(metricName: string, str: string): string {
  const rest = str.slice(str.indexOf(metricName) + metricName.length + 1);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : rest;
}

function eqMaxes(macroVector: string, eq: number, eq6: string): string[] {
  const table = (CVSS4_MAX_COMPOSED as unknown as MaxComposed)[`eq${eq}`];
  const level = macroVector[eq - 1];
  const value = eq === 3 ? (table[level] as Record<string, unknown>)[eq6] : table[level];
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * CVSS v4.0 base score (0.0–10.0). Pinned by tests against the specification's
 * anchor vectors; mirrors the standard MacroVector + severity-distance algorithm.
 */
export function cvss4BaseScore(vector: string): number {
  const sel = parseV4Vector(vector);
  const mv = cvss4MacroVector(sel);
  // No impact on any scope → 0.0 by definition.
  if (["VC", "VI", "VA", "SC", "SI", "SA"].every((k) => metric(sel, k) === "N")) return 0;
  const value = CVSS4_LOOKUP[mv];
  if (value === undefined) throw new Error(`macrovector ${mv} tak ada di tabel CVSS v4.0`);

  const [eq1, eq2, eq3, eq4, eq5, eq6] = mv.split("").map(Number);
  const lower = (digits: number[]) => digits.join("");
  const lookup = (key: string) => CVSS4_LOOKUP[key];

  const eq1Next = lower([eq1 + 1, eq2, eq3, eq4, eq5, eq6]);
  const eq2Next = lower([eq1, eq2 + 1, eq3, eq4, eq5, eq6]);
  let eq3eq6Next = "";
  let eq3eq6Left = "";
  let eq3eq6Right = "";
  if (eq3 === 1 && eq6 === 1) eq3eq6Next = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1]);
  else if (eq3 === 0 && eq6 === 1) eq3eq6Next = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
  else if (eq3 === 1 && eq6 === 0) eq3eq6Next = lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
  else if (eq3 === 0 && eq6 === 0) {
    eq3eq6Left = lower([eq1, eq2, eq3, eq4, eq5, eq6 + 1]);
    eq3eq6Right = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6]);
  } else eq3eq6Next = lower([eq1, eq2, eq3 + 1, eq4, eq5, eq6 + 1]);
  const eq4Next = lower([eq1, eq2, eq3, eq4 + 1, eq5, eq6]);
  const eq5Next = lower([eq1, eq2, eq3, eq4, eq5 + 1, eq6]);

  let eq3eq6Lower = NaN;
  if (eq3 === 0 && eq6 === 0) {
    const l = lookup(eq3eq6Left);
    const r = lookup(eq3eq6Right);
    eq3eq6Lower = l !== undefined && (r === undefined || l > r) ? l : r;
  } else eq3eq6Lower = lookup(eq3eq6Next);

  const distances: number[] = [value - lookup(eq1Next), value - lookup(eq2Next), value - eq3eq6Lower, value - lookup(eq4Next), value - lookup(eq5Next)];

  // Highest-severity vector reachable inside this MacroVector.
  const eq3Maxes = eqMaxes(mv, 3, String(eq6));
  const maxVectors: string[] = [];
  for (const a of eqMaxes(mv, 1, String(eq6)))
    for (const b of eqMaxes(mv, 2, String(eq6)))
      for (const c of eq3Maxes)
        for (const d of eqMaxes(mv, 4, String(eq6)))
          for (const e of eqMaxes(mv, 5, String(eq6))) maxVectors.push(a + b + c + d + e);

  const keys = ["AV", "PR", "UI", "AC", "AT", "VC", "VI", "VA", "SC", "SI", "SA", "CR", "IR", "AR"];
  const severity = new Array<number>(keys.length).fill(0);
  for (const maxVector of maxVectors) {
    let ok = true;
    for (let i = 0; i < keys.length; i++) {
      const mine = metric(sel, keys[i]) ?? "";
      const theirs = extractMetric(keys[i], maxVector);
      const a = LEVELS[keys[i]]?.[mine];
      const b = LEVELS[keys[i]]?.[theirs];
      const d = a === undefined || b === undefined ? NaN : a - b;
      if (Number.isNaN(d) || d < 0) {
        ok = false;
        break;
      }
      severity[i] = d;
    }
    if (ok) break;
  }
  const dist = (from: number, to: number) => severity.slice(from, to + 1).reduce((s, n) => s + n, 0);
  const current = [dist(0, 2), dist(3, 4), dist(5, 7) + dist(11, 13), dist(8, 10)];
  const depth = [
    (CVSS4_MAX_SEVERITY.eq1 as Record<string, number>)[String(eq1)] * 0.1,
    (CVSS4_MAX_SEVERITY.eq2 as Record<string, number>)[String(eq2)] * 0.1,
    ((CVSS4_MAX_SEVERITY.eq3eq6 as Record<string, Record<string, number>>)[String(eq3)] ?? {})[String(eq6)] * 0.1,
    (CVSS4_MAX_SEVERITY.eq4 as Record<string, number>)[String(eq4)] * 0.1,
  ];

  const normalized: number[] = [];
  let existing = 0;
  for (let i = 0; i < 5; i++) {
    const available = distances[i];
    if (Number.isNaN(available)) continue;
    existing++;
    // EQ5 has no severity distance (its percentage is always 0).
    const percent = i === 4 ? 0 : depth[i] ? current[i] / depth[i] : 0;
    normalized.push(available * percent);
  }
  const mean = existing === 0 ? 0 : normalized.reduce((s, n) => s + n, 0) / existing;
  const score = Math.min(10, Math.max(0, value - mean));
  return Math.round(score * 10) / 10;
}
