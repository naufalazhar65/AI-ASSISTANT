// threatModel.ts — per-target threat models (adapted from Strix
// strix/tools/threat_model/tools.py, Apache-2.0, 2026-09-26).
//
// The gap it closes: Mia's flow jumps straight from recon to probing. Strix
// forces a WRITTEN model of the target before testing — overview, trust
// boundaries, attack surface, severity calibration — persisted per target and
// amended as understanding grows. That model is what makes severity
// calibration honest (a critical finding on a toy static page reads
// differently than on an auth'd money path) and gives every report a
// "what IS this system" section instead of a bare findings list.
//
// Store: .data/users/<user>/threat-models.json (sanitizeUser + atomic write,
// cap MAX_MODELS). One model per normalized target host. Sections are free
// text but the four required ones must be non-trivial (MIN_SECTION_CHARS);
// amendments (min AMENDMENT_MIN_CHARS, capped, oldest dropped) record how the
// understanding evolved. Pure helpers are unit-tested (threatModel.test.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot, sanitizeUser } from "./users";
import { normalizeHost } from "./engagement";

/** Sections every model must carry (Strix REQUIRED_SECTIONS, snake_cased). */
export const REQUIRED_SECTIONS = ["overview", "trust_boundaries", "attack_surface", "severity_calibration"] as const;
export type ThreatModelSection = (typeof REQUIRED_SECTIONS)[number];
export type ThreatModelSections = Partial<Record<ThreatModelSection, string>>;

export const SECTION_LABEL: Record<ThreatModelSection, string> = {
  overview: "Overview",
  trust_boundaries: "Trust boundaries",
  attack_surface: "Attack surface",
  severity_calibration: "Severity calibration",
};

export type ThreatAmendment = { at: string; text: string };

export type ThreatModel = {
  id: string;
  host: string;
  sections: ThreatModelSections;
  amendments: ThreatAmendment[];
  createdAt: string;
  updatedAt: string;
};

const MAX_MODELS = 20;
const MAX_MODELS_BYTES = 512 * 1024;
/** A section shorter than this is a placeholder, not understanding. */
export const MIN_SECTION_CHARS = 20;
export const AMENDMENT_MIN_CHARS = 30;
const MAX_AMENDMENTS = 40;

function storePath(userKey: string): string {
  return join(appRoot(), ".data", "users", userKey, "threat-models.json");
}

function readStore(userKey: string): ThreatModel[] {
  try {
    const p = storePath(userKey);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as { models?: ThreatModel[] } | ThreatModel[];
    const models = Array.isArray(raw) ? raw : raw.models || [];
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

function writeStore(userKey: string, models: ThreatModel[]): void {
  const p = storePath(userKey);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify({ models }, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, p);
  } catch {
    unlinkSync(tmp);
    throw new Error("gagal menulis threat-model store");
  }
}

/** Which required sections are missing/too-trivial in this model? Pure. Tested. */
export function missingSections(sections: ThreatModelSections): ThreatModelSection[] {
  return REQUIRED_SECTIONS.filter((s) => String(sections?.[s] || "").trim().length < MIN_SECTION_CHARS);
}

/** Normalize input sections: accept the snake_case keys or their human labels. Pure. */
export function canonicalSections(input: Record<string, unknown>): ThreatModelSections {
  const out: ThreatModelSections = {};
  for (const [k, v] of Object.entries(input || {})) {
    const key = String(k).trim().toLowerCase().replace(/[\s-]+/g, "_") as ThreatModelSection;
    if ((REQUIRED_SECTIONS as readonly string[]).includes(key) && typeof v === "string" && v.trim()) {
      out[key] = v.trim();
    }
  }
  return out;
}

/** Render a model as markdown (report-ready). Pure. Tested. */
export function renderThreatModel(m: ThreatModel): string {
  const lines = [`# Threat model — ${m.host}`];
  for (const s of REQUIRED_SECTIONS) {
    lines.push("", `## ${SECTION_LABEL[s]}`, "", String(m.sections[s] || "").trim() || "(belum diisi)");
  }
  if (m.amendments.length) {
    lines.push("", "## Amendments", "", ...m.amendments.map((a) => `- (${a.at.slice(0, 10)}) ${a.text}`));
  }
  return lines.join("\n");
}

/** Report section, scoped to one host. Pure. Tested. */
export function threatModelReportSection(m: ThreatModel): string {
  const counts = REQUIRED_SECTIONS.map((s) => (String(m.sections[s] || "").trim().length >= MIN_SECTION_CHARS ? 1 : 0)).reduce<number>((a, b) => a + b, 0);
  if (!counts) return "";
  return [
    "## Threat model",
    "",
    `**Overview**: ${m.sections.overview?.trim() || "—"}`,
    `**Trust boundaries**: ${m.sections.trust_boundaries?.trim() || "—"}`,
    `**Attack surface**: ${m.sections.attack_surface?.trim() || "—"}`,
    `**Severity calibration**: ${m.sections.severity_calibration?.trim() || "—"}`,
  ].join("\n");
}

export function getThreatModel(rawUser: unknown, target: string): ThreatModel | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const host = normalizeHost(target);
  if (!host) return null;
  return readStore(userKey).find((m) => m.host === host) || null;
}

/** Create or update the model for a target (sections merge over the existing). */
export function saveThreatModel(rawUser: unknown, target: string, sections: Record<string, unknown>): ThreatModel {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const host = normalizeHost(target);
  if (!host) throw new Error("target wajib — host/URL yang dimodelkan");
  const canon = canonicalSections(sections);
  const models = readStore(userKey);
  const existing = models.find((m) => m.host === host);
  const merged: ThreatModelSections = { ...existing?.sections, ...canon };
  const missing = missingSections(merged);
  if (missing.length) {
    throw new Error(
      `threat model belum lengkap — isi minimal ${MIN_SECTION_CHARS} karakter untuk: ${missing.map((s) => SECTION_LABEL[s]).join(", ")}`,
    );
  }
  const now = new Date().toISOString();
  if (existing) {
    existing.sections = merged;
    existing.updatedAt = now;
    writeStore(userKey, models);
    return existing;
  }
  const model: ThreatModel = {
    id: `TM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    host,
    sections: merged,
    amendments: [],
    createdAt: now,
    updatedAt: now,
  };
  models.push(model);
  while (models.length > MAX_MODELS) models.shift();
  writeStore(userKey, models);
  return model;
}

/** Append an amendment (how understanding evolved). Oldest dropped past the cap. */
export function amendThreatModel(rawUser: unknown, target: string, text: string): ThreatModel {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const host = normalizeHost(target);
  const t = String(text || "").trim();
  if (!host) throw new Error("target wajib");
  if (t.length < AMENDMENT_MIN_CHARS) {
    throw new Error(`amendment terlalu pendek (min ${AMENDMENT_MIN_CHARS} karakter) — jelaskan apa yang berubah dalam pemahamanmu`);
  }
  const models = readStore(userKey);
  const model = models.find((m) => m.host === host);
  if (!model) throw new Error(`belum ada threat model untuk ${host} — simpan modelnya dulu`);
  model.amendments.push({ at: new Date().toISOString(), text: t.slice(0, 500) });
  while (model.amendments.length > MAX_AMENDMENTS) model.amendments.shift();
  model.updatedAt = new Date().toISOString();
  writeStore(userKey, models);
  return model;
}

/** The model backing a report host, if any (report integration). */
export function threatModelForHost(rawUser: unknown, host: string): ThreatModel | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey || !host) return null;
  return readStore(userKey).find((m) => m.host === normalizeHost(host)) || null;
}

export const THREAT_MODEL_LIMITS = { MAX_MODELS, MAX_MODELS_BYTES, MAX_AMENDMENTS };
