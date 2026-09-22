// idorEnum.ts — ranged IDOR enumerator (idor_enum).
//
// Tests an ID range (default 1..20) as TWO sessions (A/B): an ID counts as
// HIT only when BOTH accounts get 200 + identical body (>50b, untruncated).
// An anonymous control runs first — a publicly identical range is downgraded
// honestly (public, not IDOR), never counted.
//
// Bounds (hard): ≤30 requests total, step 1, STOP at 5 hits. Output leads
// with the concrete impact number ("17/20 ID dapat diakses") ready for
// `poc_verify`. Scope-gated, session-safe. Write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";

export type IdorHit = { id: number; status: number; len: number };

const MAX_REQUESTS = 30;
const MAX_HITS = 5;
const MAX_IDS = 20;

function buildUrl(template: string, id: number): string {
  if (/\{id\}/i.test(template)) return template.replace(/\{id\}/gi, String(id));
  try {
    const u = new URL(template);
    const params = ["id", "user_id", "uid", "account_id", "doc", "document", "file", "order_id", "profile_id", "item_id"];
    for (const p of params) {
      if (u.searchParams.has(p)) {
        u.searchParams.set(p, String(id));
        return u.toString();
      }
    }
    u.searchParams.set("id", String(id));
    return u.toString();
  } catch {
    return template;
  }
}

export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; body: string }>;

async function defaultFetch(url: string, init: { headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) }, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, 12_000) };
  } catch {
    return { status: 0, body: "" };
  }
}

function digest(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16);
}

/**
 * Enumerate an ID range as two sessions. Scope-gated, bounded.
 * `url`: full URL with `{id}` placeholder, or any URL with an ID-ish param.
 */
export async function idorEnum(
  rawUser: unknown,
  opts: { url?: string; session_a?: string; session_b?: string; id_start?: number; id_end?: number; fetchFn?: FetchFn } = {}
): Promise<string> {
  const template = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(template)) return "Error: url harus http(s) — pakai `{id}` untuk placeholder ID.";
  if (!targetAllowed(template)) return "Error: SCOPE — idor_enum hanya untuk lab / engagement aktif.";
  const sa = opts.session_a ? sessionHeaders(rawUser, opts.session_a) : null;
  const sb = opts.session_b ? sessionHeaders(rawUser, opts.session_b) : null;
  if (!sa || !sb) return "Error: butuh 2 sesi (session_a + session_b) — siapkan via `auth_setup` dulu.";
  const hA: Record<string, string> = { ...(sa.headers || {}) };
  if (sa.cookie) hA["cookie"] = sa.cookie;
  const hB: Record<string, string> = { ...(sb.headers || {}) };
  if (sb.cookie) hB["cookie"] = sb.cookie;

  const start = Math.max(1, Math.min(100000, Math.floor(Number(opts.id_start) || 1)));
  const end = Math.max(start, Math.min(start + MAX_IDS - 1, Math.floor(Number(opts.id_end) || start + MAX_IDS - 1)));
  const ids: number[] = [];
  for (let id = start; id <= end && ids.length < MAX_IDS; id++) ids.push(id);
  const fetchFn = opts.fetchFn || defaultFetch;
  const lines: string[] = [`🔢 IDOR ENUM ${template} — ID ${start}..${end} (maks ${MAX_IDS} ID, ${MAX_REQUESTS} request, stop di ${MAX_HITS} hit)`];

  // Anonymous control on the first ID: identical-for-everyone = public.
  let used = 0;
  let pub = false;
  try {
    const first = buildUrl(template, ids[0]);
    await politeDelay();
    const [ca, cb, cn] = await Promise.all([
      fetchFn(first, { headers: hA }),
      fetchFn(first, { headers: hB }),
      fetchFn(first, {}),
    ]);
    used += 3;
    if (ca.status === 200 && digest(ca.body) === digest(cn.body) && ca.body.length > 50) {
      pub = true;
      lines.push("ℹ️ Kontrol anon: respons IDENTIK tanpa sesi — rentang ini PUBLIK, bukan IDOR. Enum dibatalkan jujur.");
    }
  } catch { /* control best-effort; continue carefully */ }
  if (pub) return lines.join("\n");

  const hits: IdorHit[] = [];
  let tested = 0;
  for (const id of ids) {
    if (hits.length >= MAX_HITS || used + 2 > MAX_REQUESTS) break;
    const u = buildUrl(template, id);
    if (!targetAllowed(u)) continue;
    let ra: { status: number; body: string };
    let rb: { status: number; body: string };
    try {
      await politeDelay();
      ra = await fetchFn(u, { headers: hA });
      await politeDelay();
      rb = await fetchFn(u, { headers: hB });
      used += 2;
      tested++;
    } catch {
      continue;
    }
    if (ra.status === 200 && rb.status === 200 && ra.body.length > 50 && digest(ra.body) === digest(rb.body)) {
      hits.push({ id, status: 200, len: ra.body.length });
      lines.push(`• 🔴 id=${id} → A=200 B=200 IDENTIK (${ra.body.length}b)`);
    }
  }
  lines.push("");
  if (hits.length) {
    lines.push(`⛔ ${hits.length}/${tested} ID dapat diakses dua akun — BOLA/IDOR massal. ID: ${hits.map((h) => h.id).join(", ")}. Lanjut \`poc_verify\` (baseline + kontrol) → \`finding_add\`.`);
  } else {
    lines.push(`✅ ${tested} ID diuji, tidak ada yang identik dua-akun — bukan IDOR massal pada rentang ini.`);
  }
  if (hits.length >= MAX_HITS) lines.push("(Stop di 5 hit sesuai bound — rentang penuh belum diuji.)");
  return lines.join("\n");
}
