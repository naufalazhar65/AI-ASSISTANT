import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDir } from "./baseline";
import type { BaselineComparison } from "./baseline";
import type { EvalRunReport } from "./types";

/**
 * Reports. JSON for machines, Markdown for humans.
 *
 * `writeReport` verifies the files it just wrote by reading them back, so a
 * report is never claimed as generated unless it can be read (spec §15).
 */

export interface ArtifactResult {
  path: string;
  bytes: number;
  verified: boolean;
  problem?: string;
}

const pct = (p: number | null): string => (p === null ? "tidak diukur" : `${p}%`);

export function renderMarkdown(report: EvalRunReport, comparison?: BaselineComparison): string {
  const lines: string[] = [];
  lines.push(`# Evaluasi Agent — ${report.run_id}`);
  lines.push("");
  lines.push("## Ringkasan eksekutif");
  lines.push("");
  lines.push(`- Revisi kandidat: \`${report.revision}\``);
  lines.push(`- Baseline: ${comparison ? `\`${comparison.baseline_revision}\`` : "tidak ada (run pertama)"}`);
  lines.push(`- Dataset v${report.dataset_version} · rubric v${report.rubric_version} · harness v${report.harness_version}`);
  lines.push(`- Kasus dipilih: ${report.totals.selected} — pass ${report.totals.pass}, fail ${report.totals.fail}, blocked ${report.totals.blocked}, N/A ${report.totals.not_applicable}`);
  lines.push(`- Skor agregat (dashboard saja): ${report.aggregate.score ?? "tidak dihitung"}`);
  lines.push(`- Panggilan model: ${report.model_calls}`);
  for (const n of report.notes) lines.push(`- Catatan: ${n}`);
  lines.push("");

  lines.push("## Metrik per dimensi");
  lines.push("");
  lines.push("| Metrik | Nilai | Pecahan | Blocked | N/A |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const m of report.metrics) {
    lines.push(`| ${m.key} | ${pct(m.percent)} | ${m.numerator}/${m.denominator} | ${m.blocked} | ${m.not_applicable} |`);
  }
  lines.push("");

  lines.push("## Performa per agent");
  lines.push("");
  const agents = [...new Set(report.cases.map((c) => c.target_agent))].sort();
  lines.push("| Agent | pass | fail | blocked | N/A |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const a of agents) {
    const mine = report.cases.filter((c) => c.target_agent === a);
    lines.push(
      `| ${a} | ${mine.filter((c) => c.status === "pass").length} | ${mine.filter((c) => c.status === "fail").length} | ` +
        `${mine.filter((c) => c.status === "blocked").length} | ${mine.filter((c) => c.status === "not_applicable").length} |`
    );
  }
  lines.push("");

  lines.push("## Kegagalan kritis");
  lines.push("");
  if (!report.critical_failures.length) lines.push("Tidak ada.");
  else for (const id of report.critical_failures) lines.push(`- \`${id}\` — ${report.cases.find((c) => c.case_id === id)?.failure_reason ?? ""}`);
  lines.push("");

  if (comparison) {
    lines.push("## Detail regresi");
    lines.push("");
    lines.push(`- Baru gagal: ${comparison.new_failures.length ? comparison.new_failures.join(", ") : "tidak ada"}`);
    lines.push(`- Sudah hijau: ${comparison.fixed.length ? comparison.fixed.join(", ") : "tidak ada"}`);
    lines.push(`- Kasus baru: ${comparison.new_cases.length ? comparison.new_cases.join(", ") : "tidak ada"}`);
    lines.push(`- Kasus hilang: ${comparison.removed_cases.length ? comparison.removed_cases.join(", ") : "tidak ada"}`);
    lines.push(
      `- Versi berubah: dataset ${comparison.dataset_version_changed ? "berubah" : "sama"}, ` +
        `rubric ${comparison.rubric_version_changed ? "berubah" : "sama"}, harness ${comparison.harness_version_changed ? "berubah" : "sama"}`
    );
    lines.push("");
    if (comparison.latency.length) {
      lines.push("| Kasus | Baseline (ms) | Kandidat (ms) | Delta |");
      lines.push("| --- | --- | --- | --- |");
      for (const l of comparison.latency) lines.push(`| ${l.case_id} | ${l.baseline_ms} | ${l.candidate_ms} | ${l.delta_ms >= 0 ? "+" : ""}${l.delta_ms} |`);
      lines.push("");
    }
  }

  lines.push("## Rincian kasus");
  lines.push("");
  lines.push("| Kasus | Kategori | Agent | Metrik | Status | Alasan |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    lines.push(
      `| \`${c.case_id}\` | ${c.category} | ${c.target_agent} | ${c.metric} | ${c.status} | ${(c.failure_reason ?? "-").replace(/\|/g, "/")} |`
    );
  }
  lines.push("");

  lines.push("## Gate");
  lines.push("");
  for (const g of report.gates) lines.push(`- ${g.ok ? "OK" : "GAGAL"} — ${g.gate}: ${g.detail}`);
  lines.push("");
  return lines.join("\n");
}

export function writeReport(report: EvalRunReport, comparison?: BaselineComparison): ArtifactResult[] {
  const dir = runDir(report.run_id);
  mkdirSync(dir, { recursive: true });
  const files: Array<{ name: string; body: string }> = [
    { name: "report.json", body: JSON.stringify({ ...report, comparison }, null, 2) },
    { name: "report.md", body: renderMarkdown(report, comparison) },
  ];
  const out: ArtifactResult[] = [];
  for (const f of files) {
    const path = join(dir, f.name);
    writeFileSync(path, f.body);
    let bytes = 0;
    let verified = false;
    let problem: string | undefined;
    try {
      const read = readFileSync(path, "utf8");
      bytes = Buffer.byteLength(read);
      verified = read.length > 0;
      if (!verified) problem = "file kosong setelah ditulis";
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    out.push({ path, bytes, verified, problem });
  }
  return out;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Slack bot/app tokens (audit 2026-10-16: xoxb/xapp were not covered).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bxapp-[A-Za-z0-9-]{10,}\b/g,
];

/** Evaluation artifacts are shared in CI, so scrub obvious credentials first. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export function redactReport(report: EvalRunReport, comparison?: BaselineComparison): EvalRunReport {
  const copy: EvalRunReport = JSON.parse(JSON.stringify(report));
  copy.cases = copy.cases.map((c) => ({
    ...c,
    name: redactSecrets(c.name),
    failure_reason: c.failure_reason ? redactSecrets(c.failure_reason) : undefined,
    criteria: c.criteria.map((x) => ({ ...x, detail: x.detail ? redactSecrets(x.detail) : x.detail })),
    evidence_reference: c.evidence_reference ? redactSecrets(c.evidence_reference) : undefined,
  }));
  return { ...copy, notes: copy.notes.map(redactSecrets) } as EvalRunReport & { comparison?: BaselineComparison };
}