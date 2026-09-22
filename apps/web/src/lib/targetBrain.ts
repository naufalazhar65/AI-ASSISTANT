// Target Brain — a persistent, per-target knowledge base so Mia "remembers"
// an application across sessions: endpoints/params seen, auth model, tech
// fingerprint, what was PROVEN (and how), what was tested-safe, and open
// findings. Tools write here automatically (content_discover, tech_watch,
// exploit chains, finding_add); the agent reads it before hunting so a new
// session resumes where the last one stopped instead of re-treading.
//
// Store: .data/users/<user>/target-brain.json (atomic, capped). Local only —
// no network. Pure helpers are exported for unit tests.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { normalizeTarget } from "./huntLog";

export type BrainEndpoint = {
  path: string;
  params: string[];
  methods: string[];
  /** auth model observed for this endpoint, when known */
  auth?: string;
  status: number[];
  note: string;
  updatedAt: string;
};

export type BrainProof = {
  /** what was proven, e.g. "BOLA /api/dokumen?id" */
  what: string;
  /** how it was proven (tool + args digest) */
  how: string;
  severity: string;
  findingId?: string;
  at: string;
};

export type BrainTarget = {
  host: string;
  base?: string;
  tech: string;
  authModel: string;
  endpoints: BrainEndpoint[];
  /** requests that were tested and behaved SAFE (don't re-test blindly) */
  safeTested: string[];
  proofs: BrainProof[];
  /** compact running notes (most recent first, capped) */
  notes: string[];
  updatedAt: string;
};

export type Brain = Record<string, BrainTarget>;

const MAX_TARGETS = 40;
const MAX_ENDPOINTS = 120;
const MAX_SAFE = 80;
const MAX_PROOFS = 40;
const MAX_NOTES = 20;

function storePath(rawUser: unknown): string {
  const user = sanitizeUser(rawUser) ?? "shared";
  return join(userDataRoot(), user, "target-brain.json");
}

function read(rawUser: unknown): Brain {
  try {
    const p = storePath(rawUser);
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Brain) : {};
  } catch {
    // Quarantine corrupt stores instead of resetting (audit 2026-09-23: a
    // reset + next write permanently wiped the store).
    try {
      const p = storePath(rawUser);
      if (existsSync(p)) renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch { /* best-effort */ }
    return {};
  }
}

function write(rawUser: unknown, brain: Brain): void {
  const p = storePath(rawUser);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(brain, null, 2));
  renameSync(tmp, p);
}

/** Host key from a URL/target string (no scheme, no path). Pure — tested. */
export function brainHost(target: string): string {
  const raw = (target || "").trim().toLowerCase();
  if (!raw) return "";
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).hostname || "";
  } catch {
    return "";
  }
}

function emptyTarget(host: string): BrainTarget {
  return { host, tech: "", authModel: "", endpoints: [], safeTested: [], proofs: [], notes: [], updatedAt: "" };
}

function getTarget(brain: Brain, host: string): BrainTarget {
  if (!brain[host]) brain[host] = emptyTarget(host);
  return brain[host];
}

function touch(t: BrainTarget): void {
  t.updatedAt = new Date().toISOString();
}

/** Extract the path (+query key names only) from a URL. Pure — tested. */
export function brainPathKey(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()].sort();
    const q = params.length ? `?${params.join("&")}` : "";
    return `${u.pathname}${q}`;
  } catch {
    return "";
  }
}

/**
 * Normalize an endpoint line into a storage-safe path (origin stripped).
 * Handles absolute URLs AND bare paths; query string preserved (values dropped
 * at call sites via brainParamNames). Pure.
 */
export function brainPath(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://x${s.startsWith("/") ? "" : "/"}${s}`);
    return `${u.pathname}${u.search}`;
  } catch {
    return normalizeTarget(s).replace(/^https?:\/\/[^/]+/i, "");
  }
}

/** Param names from a URL's query string (unique, sorted). Pure — tested. */
export function brainParamNames(url: string): string[] {
  try {
    return [...new Set([...new URL(url).searchParams.keys()])].sort();
  } catch {
    return [];
  }
}

/** Record endpoints (path + params) discovered on a host. Best-effort, bounded. */
export function brainRecordEndpoints(rawUser: unknown, baseUrl: string, paths: string[]): void {
  const host = brainHost(baseUrl);
  if (!host || !paths.length) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  const now = new Date().toISOString();
  for (const raw of paths.slice(0, MAX_ENDPOINTS)) {
    const path = brainPath(raw);
    if (!path || path === "/") continue;
    const params = brainParamNames(`http://x${path.startsWith("/") ? "" : "/"}${path}`);
    // Store names-only query (audit 2026-09-23): brainPath keeps ?values=
    // which persisted tokens/IDs to disk + prompt via brainBrief. Strip them.
    const bare = path.split("?")[0];
    const stored = params.length ? `${bare}?${params.join("&")}` : bare;
    const key = bare;
    const existing = t.endpoints.find((e) => e.path.split("?")[0] === key);
    if (existing) {
      existing.params = [...new Set([...existing.params, ...params])].slice(0, 12);
      existing.path = stored;
      existing.updatedAt = now;
    } else {
      t.endpoints.push({ path: stored, params, methods: [], status: [], note: "", updatedAt: now });
    }
  }
  while (t.endpoints.length > MAX_ENDPOINTS) t.endpoints.shift();
  touch(t);
  write(rawUser, brain);
}

/** Record observed statuses/methods for one endpoint (from an executed request). */
export function brainRecordObservation(rawUser: unknown, url: string, opts: { status?: number; method?: string; note?: string } = {}): void {
  const host = brainHost(url);
  const path = brainPathKey(url);
  if (!host || !path) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  const key = path.split("?")[0];
  const e = t.endpoints.find((x) => x.path.split("?")[0] === key) ?? { path, params: brainParamNames(url), methods: [], status: [], note: "", updatedAt: "" };
  if (opts.method) e.methods = [...new Set([...e.methods, opts.method.toUpperCase()])].slice(0, 6);
  if (typeof opts.status === "number" && opts.status > 0) e.status = [...new Set([...e.status, opts.status])].slice(0, 8);
  if (opts.note) e.note = opts.note.slice(0, 160);
  e.updatedAt = new Date().toISOString();
  if (!t.endpoints.includes(e)) t.endpoints.push(e);
  while (t.endpoints.length > MAX_ENDPOINTS) t.endpoints.shift();
  touch(t);
  write(rawUser, brain);
}

/** Record the tech fingerprint (from tech_watch / native fingerprint). */
export function brainRecordTech(rawUser: unknown, baseUrl: string, tech: string): void {
  const host = brainHost(baseUrl);
  if (!host || !tech) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  t.tech = tech.slice(0, 300);
  touch(t);
  write(rawUser, brain);
}

/** Record the auth model ("cookie session", "Bearer JWT", "none observed", …). */
export function brainRecordAuth(rawUser: unknown, baseUrl: string, authModel: string): void {
  const host = brainHost(baseUrl);
  if (!host || !authModel) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  t.authModel = authModel.slice(0, 200);
  touch(t);
  write(rawUser, brain);
}

/** Record a request/param that was tested and behaved SAFE (bounded, deduped). */
export function brainRecordSafe(rawUser: unknown, url: string, what: string): void {
  const host = brainHost(url);
  if (!host || !what) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  const entry = `${brainPathKey(url) || url} :: ${what.slice(0, 160)}`;
  t.safeTested = [entry, ...t.safeTested.filter((x) => x !== entry)].slice(0, MAX_SAFE);
  touch(t);
  write(rawUser, brain);
}

/** Record a PROVEN finding on this target (what/how/severity/findingId). */
export function brainRecordProof(rawUser: unknown, baseUrl: string, proof: Omit<BrainProof, "at">): void {
  const host = brainHost(baseUrl);
  if (!host || !proof.what) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  t.proofs = [{ ...proof, what: proof.what.slice(0, 200), how: proof.how.slice(0, 400), severity: proof.severity.slice(0, 20), at: new Date().toISOString() }, ...t.proofs.filter((p) => p.what !== proof.what)].slice(0, MAX_PROOFS);
  touch(t);
  write(rawUser, brain);
}

/** Append a free-form note (deduped, newest first). */
export function brainNote(rawUser: unknown, baseUrl: string, note: string): void {
  const host = brainHost(baseUrl);
  if (!host || !note) return;
  const brain = read(rawUser);
  const t = getTarget(brain, host);
  t.notes = [note.slice(0, 300), ...t.notes.filter((n) => n !== note)].slice(0, MAX_NOTES);
  touch(t);
  write(rawUser, brain);
}

/** The compact brief the agent reads BEFORE hunting a target. */
export function brainBrief(rawUser: unknown, targetRaw: string): string {
  const host = brainHost(targetRaw);
  if (!host) return "Error: target tidak valid (pakai host/URL).";
  const brain = read(rawUser);
  const t = brain[host];
  if (!t || (!t.endpoints.length && !t.proofs.length && !t.tech && !t.authModel && !t.safeTested.length && !t.notes.length)) {
    return `🧠 Target brain ${host}: kosong — belum ada data. Jalankan content_discover/tech_watch/scan dulu; hasilnya otomatis tercatat di sini.`;
  }
  const lines: string[] = [`🧠 TARGET BRAIN ${host}${t.updatedAt ? ` (update ${t.updatedAt.slice(0, 16)})` : ""}`];
  if (t.tech) lines.push(`Tech: ${t.tech}`);
  if (t.authModel) lines.push(`Auth: ${t.authModel}`);
  if (t.proofs.length) {
    lines.push(`\n✅ TERBUKTI (${t.proofs.length}):`);
    for (const p of t.proofs.slice(0, 8)) lines.push(`• [${p.severity}] ${p.what} — via ${p.how}${p.findingId ? ` (${p.findingId})` : ""}`);
  }
  if (t.endpoints.length) {
    lines.push(`\n🗺️ Endpoints (${t.endpoints.length}):`);
    for (const e of t.endpoints.slice(0, 25)) {
      lines.push(`• ${e.path}${e.params.length ? ` [${e.params.join(", ")}]` : ""}${e.methods.length ? ` (${e.methods.join("/")})` : ""}${e.status.length ? ` → ${e.status.join(",")}` : ""}${e.note ? ` — ${e.note}` : ""}`);
    }
    if (t.endpoints.length > 25) lines.push(`… +${t.endpoints.length - 25} lagi (lihat target_brain action=endpoints)`);
  }
  if (t.safeTested.length) {
    lines.push(`\n🧷 Sudah dites aman (${t.safeTested.length}) — jangan ulang buta:`);
    for (const s of t.safeTested.slice(0, 6)) lines.push(`• ${s}`);
  }
  if (t.notes.length) {
    lines.push(`\n📝 Catatan:`);
    for (const n of t.notes.slice(0, 6)) lines.push(`• ${n}`);
  }
  return lines.join("\n");
}

/** Attack-class taxonomy for coverage: keyword matchers over proof/finding/hunt text. Pure data. */
export const COVERAGE_CLASSES: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "recon", label: "Recon", re: /recon|discover|js_mine|subdomain|endpoint|crawl/i },
  { key: "headers", label: "Headers/CSP/cookies", re: /csp|hsts|header|cookie|samesite|cors/i },
  { key: "xss", label: "XSS", re: /xss|cross.?site.script|innerhtml|dom\b|taint/i },
  { key: "sqli", label: "SQLi", re: /sqli|sql.injection|sql.error|union.select/i },
  { key: "idor", label: "IDOR/BOLA", re: /idor|bola|broken.?access|\bbac\b/i },
  { key: "mass", label: "Mass assignment", re: /mass.?assignment/i },
  { key: "auth", label: "Auth/session", re: /auth|session|fixation|login|jwt|bypass|oauth|csrf/i },
  { key: "ssrf", label: "SSRF", re: /\bssrf\b|server.side.request|\boost\b/i },
  { key: "xxe", label: "XXE", re: /\bxxe\b|external.entit/i },
  { key: "ssti", label: "SSTI", re: /ssti|template.injection|jinja|twig/i },
  { key: "redirect", label: "Open redirect", re: /open.?redirect/i },
  { key: "upload", label: "Upload", re: /upload|polyglot/i },
  { key: "race", label: "Race", re: /\brace\b|toctou|nonce|duplicate/i },
  { key: "graphql", label: "GraphQL", re: /graphql/i },
  { key: "ws", label: "WebSocket", re: /websocket|cswsh/i },
  { key: "cache", label: "Cache poisoning", re: /cache.poison/i },
  { key: "llm", label: "LLM/AI", re: /\bllm\b|prompt.?injection|jailbreak|\bmcp\b/i },
  { key: "exposure", label: "Exposure (.git/.env)", re: /exposure|\.git|\.env|backup/i },
];

/** Which classes show evidence in a text blob. Pure. */
export function coverageTried(text: string): Set<string> {
  const out = new Set<string>();
  for (const c of COVERAGE_CLASSES) {
    c.re.lastIndex = 0;
    if (c.re.test(text || "")) out.add(c.key);
  }
  return out;
}

/**
 * Coverage report for one host: endpoint test %, proofs/findings counts, and
 * per-class TRIED vs GAP so hunts have no blind spots. Honest: GAP means "no
 * evidence in brain/hunt/findings", not "vulnerable". Read-only, no network.
 */
export async function brainCoverage(rawUser: unknown, targetRaw: string): Promise<string> {
  const host = brainHost(targetRaw);
  if (!host) return "Error: target tidak valid (pakai host/URL).";
  const t = read(rawUser)[host];
  const { readHunt } = await import("./huntLog");
  const { readFindings } = await import("./security");
  const hunts = readHunt(rawUser).filter((h) => (h.target || "").toLowerCase().includes(host));
  const findings = readFindings(rawUser).filter(
    (f) => f.status !== "resolved" && ((f.target || "").toLowerCase().includes(host))
  );
  if (!t && !hunts.length && !findings.length) {
    return `🧠 Coverage ${host}: kosong — belum ada data brain/hunt/finding. Mulai dengan content_discover.`;
  }
  const endpoints = t?.endpoints ?? [];
  const safe = new Set((t?.safeTested ?? []).map((s) => s.split("?")[0]));
  const tested = endpoints.filter((e) => e.status.length > 0 || safe.has(e.path.split("?")[0])).length;
  const pct = endpoints.length ? Math.round((tested / endpoints.length) * 100) : 0;
  const corpus = [
    ...(t?.proofs ?? []).map((p) => `${p.what} ${p.how}`),
    ...findings.map((f) => `${f.title} ${f.owasp} ${f.cwe} ${f.evidence} ${f.steps}`),
    ...hunts.map((h) => `${h.status} ${h.note} ${h.evidence}`),
    ...(t?.notes ?? []),
  ].join("\n");
  const tried = coverageTried(corpus);
  // Recon counts as tried when endpoints were discovered at all.
  if (endpoints.length) tried.add("recon");
  const gaps = COVERAGE_CLASSES.filter((c) => !tried.has(c.key));
  const lines: string[] = [`🧭 COVERAGE ${host} — endpoint teruji ${tested}/${endpoints.length} (${pct}%) · terbukti ${t?.proofs.length ?? 0} · temuan open ${findings.length} · aman ${t?.safeTested.length ?? 0}`];
  const triedLabels = COVERAGE_CLASSES.filter((c) => tried.has(c.key)).map((c) => c.label);
  lines.push(`✅ Teruji: ${triedLabels.length ? triedLabels.join(", ") : "—"}`);
  lines.push(gaps.length ? `🕳️ Gap (belum ada bukti uji): ${gaps.map((c) => c.label).join(", ")}` : "🎉 Tidak ada gap kelas — semua teruji minimal sekali.");
  const untested = endpoints.filter((e) => e.status.length === 0 && !safe.has(e.path.split("?")[0])).slice(0, 8);
  if (untested.length) lines.push(`Endpoint belum tersentuh: ${untested.map((e) => e.path).join(", ")}${endpoints.length - tested > 8 ? "…" : ""}`);
  return lines.join("\n");
}

/** Raw target entry (for joins/tests). */
export function brainGet(rawUser: unknown, targetRaw: string): BrainTarget | null {
  const host = brainHost(targetRaw);
  if (!host) return null;
  return read(rawUser)[host] ?? null;
}

/** Drop one target entirely (reset). */
export function brainForget(rawUser: unknown, targetRaw: string): boolean {
  const host = brainHost(targetRaw);
  if (!host) return false;
  const brain = read(rawUser);
  if (!(host in brain)) return false;
  delete brain[host];
  write(rawUser, brain);
  return true;
}

/** List targets with data. */
export function brainListText(rawUser: unknown): string {
  const brain = read(rawUser);
  const entries = Object.values(brain).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  if (!entries.length) return "🧠 Target brain kosong — belum ada target yang dipetakan.";
  return `🧠 Target brain (${entries.length} target):\n${entries.map((t) => `• ${t.host} — ${t.endpoints.length} endpoint, ${t.proofs.length} terbukti, ${t.safeTested.length} aman${t.tech ? `, tech: ${t.tech.slice(0, 60)}` : ""}`).join("\n")}`;
}

/** Enforce the per-user target cap (LRU by updatedAt). */
export function brainTrim(rawUser: unknown): void {
  const brain = read(rawUser);
  const entries = Object.entries(brain).sort((a, b) => (a[1].updatedAt || "").localeCompare(b[1].updatedAt || ""));
  if (entries.length <= MAX_TARGETS) return;
  const next: Brain = {};
  for (const [k, v] of entries.slice(entries.length - MAX_TARGETS)) next[k] = v;
  write(rawUser, next);
}
