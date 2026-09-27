// ownerLabs.ts — the owner's persistent lab registry.
//
// The gap it closes (live 2026-09-27, twice): the owner names a NEW host as
// his own ("tambahkan https://naufalv3.netlify.app/ ke lab pentest") and the
// only authorization channels were (a) the PENTEST_LAB_TARGETS env — which no
// tool can write — or (b) an engagement the model on capped providers rarely
// creates. Result: refusals like "aku tidak bisa melakukan pengujian
// keamanan" that contradict the turn's own tool activity.
//
// Design: the owner's DECLARATION is the authorization (same rule the prompt
// already states, now backed by a writable store the model can actually
// call). One host row per user; `isOwnerLabHost(rawUser, host)` feeds
// `isOwnLabTarget` so every existing scope gate honors it with no per-tool
// change. The env list stays authoritative for it; the store ADDS to it.
//
// Store: .data/users/<user>/owner-labs.json (sanitizeUser + atomic write, cap
// MAX_LABS). Hosts are not secrets; the registry is checked on EVERY
// scope-gated tool call, so reads are served from a module cache invalidated
// by mtime.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./users";
import { normalizeHost } from "./engagement";

export interface OwnerLab {
  host: string;
  addedAt: string;
  /** The user's own words when claiming the host — the audit trail. */
  note?: string;
}

const MAX_LABS = 40;

/**
 * THE OWNER REGISTRY IS SINGLE (global, not per-user). Owner-lab membership
 * is a fact about the OWNER, not about a chat account: a host declared from
 * Discord (`Zigen`) must be testable from the web app and Telegram, and the
 * no-user scope path (isOwnLabTarget) must find it. Any key NOT in
 * OWNER_KEYS is treated as the owner too — this tool is only exposed in the
 * owner's channels, and a shared global registry cannot leak anything
 * (hosts are not secrets). This also makes every caller agree: add from any
 * channel, visible to every gate, forgettable from any channel.
 */
const OWNER_REGISTRY_KEY = "naufalazhar652952";

/* eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature
   keeps rawUser so call-sites stay identical to a future per-user registry. */
function resolveKey(_rawUser: unknown): string {
  return OWNER_REGISTRY_KEY;
}

function storePath(userKey: string): string {
  return join(appRoot(), ".data", "users", userKey, "owner-labs.json");
}

function readStore(userKey: string): OwnerLab[] {
  try {
    const p = storePath(userKey);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as { labs?: OwnerLab[] } | OwnerLab[];
    const labs = Array.isArray(raw) ? raw : raw.labs || [];
    return Array.isArray(labs) ? labs : [];
  } catch {
    return [];
  }
}

function writeStore(userKey: string, labs: OwnerLab[]): void {
  const p = storePath(userKey);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify({ labs }, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, p);
  } catch {
    unlinkSync(tmp);
    throw new Error("gagal menulis owner-labs store");
  }
}

/** Pure: canonical bare host for a claimed URL/host, or "" when unusable. */
export function labHost(raw: string): string {
  const host = normalizeHost(raw);
  // normalizeHost already strips scheme/port/wildcard; require at least one
  // dot (a bare "localhost" stays reserved for the built-in rule) and reject
  // anything with spaces or a path left over.
  if (!host || !host.includes(".")) return "";
  if (/\s/.test(String(raw || ""))) return "";
  return host;
}

/** Register a host the OWNER declared his own. Idempotent per host. */
export function addOwnerLab(rawUser: unknown, hostRaw: string, note?: string): OwnerLab {
  const userKey = resolveKey(rawUser);
  if (!userKey) throw new Error("invalid user");
  const host = labHost(hostRaw);
  if (!host) throw new Error("host tidak valid — beri hostname/URL, mis. https://lab.example/");
  const labs = readStore(userKey);
  const existing = labs.find((l) => l.host === host);
  if (existing) {
    existing.addedAt = new Date().toISOString();
    if (note) existing.note = note.slice(0, 300);
    writeStore(userKey, labs);
    return existing;
  }
  const row: OwnerLab = { host, addedAt: new Date().toISOString(), ...(note ? { note: note.slice(0, 300) } : {}) };
  labs.push(row);
  if (labs.length > MAX_LABS) labs.splice(0, labs.length - MAX_LABS);
  writeStore(userKey, labs);
  return row;
}

export function listOwnerLabs(rawUser: unknown): OwnerLab[] {
  const userKey = resolveKey(rawUser);
  if (!userKey) return [];
  return readStore(userKey);
}

export function forgetOwnerLab(rawUser: unknown, hostRaw: string): boolean {
  const userKey = resolveKey(rawUser);
  if (!userKey) throw new Error("invalid user");
  const host = labHost(hostRaw);
  if (!host) return false;
  const labs = readStore(userKey);
  const i = labs.findIndex((l) => l.host === host);
  if (i === -1) return false;
  labs.splice(i, 1);
  writeStore(userKey, labs);
  return true;
}

/**
 * Is this host registered as the OWNER's own lab (exact or subdomain)? The
 * mtime cache keeps the per-tool-call cost at one stat — scope checks run on
 * every gated tool call.
 */
const cache = new Map<string, { mtimeMs: number; hosts: string[] }>();

export function isOwnerLabHost(rawUser: unknown, rawHost: string): boolean {
  const userKey = resolveKey(rawUser);
  if (!userKey) return false;
  const host = normalizeHost(rawHost);
  if (!host) return false;
  const p = storePath(userKey);
  let hosts: string[] = [];
  try {
    const mtime = statSync(p).mtimeMs;
    const hit = cache.get(userKey);
    if (hit && hit.mtimeMs === mtime) hosts = hit.hosts;
    else {
      hosts = readStore(userKey).map((l) => l.host);
      cache.set(userKey, { mtimeMs: mtime, hosts });
    }
  } catch {
    hosts = readStore(userKey).map((l) => l.host);
    cache.set(userKey, { mtimeMs: 0, hosts });
  }
  if (!hosts.length) return false;
  // Same rule as the env list: the registered domain also covers its
  // subdomains (recon finds api.<lab> and must be able to probe it).
  return hosts.some((h) => host === h || host.endsWith("." + h));
}

/** "owner-labs.json" line for pentest_resources / prompt injection. */
export function ownerLabsLine(rawUser: unknown): string {
  const labs = listOwnerLabs(rawUser);
  if (!labs.length) return "";
  return labs.map((l) => l.host).join(", ");
}

/**
 * Owner-identity check for call paths that carry NO user (security.ts
 * `isOwnLabTarget(raw)` feeds ~40 scope gates from a bare target string).
 * The registry is single and owner-scoped, so this is just the canonical-key
 * lookup.
 */
export function isOwnerLabHostForOwner(rawHost: string): boolean {
  return isOwnerLabHost(OWNER_REGISTRY_KEY, rawHost);
}
