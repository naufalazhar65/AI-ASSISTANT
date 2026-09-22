// authSetup.ts — one-command test-session wizard (auth_setup).
//
// The #1 reason exploit chains structurally skip is missing sessions: idor
// needs 2 http_sessions, auth_bypass a token-bearing one (audit 2026-09-23:
// 23 chain runs vs ~0 real sessions). This loops the proven atoProve login
// flow for up to 4 accounts and returns session names ready for exploit_chain
// (session_a/session_b), bola_diff, auth_matrix, or http_request.
//
// Boundaries: lab/engagement scope only (targetAllowed per URL, enforced by
// atoProve); passwords NEVER echoed (maskPassword) and never returned — only
// session names + cookie-name lists. max 4 accounts, bounded requests.
// Write — confirm.

import { atoProve, maskPassword, parseCredential } from "./ato";
import { readSessions } from "./httpSession";
import { targetAllowed } from "./security";

export type SetupAccount = { credential?: string; username?: string; password?: string; session?: string };
export type SetupOpts = {
  login_url?: string;
  accounts?: SetupAccount[];
  user_field?: string;
  pass_field?: string;
  body_template?: string;
  protected_url?: string;
};

const MAX_ACCOUNTS = 4;

/** Session-name hygiene: filesystem + reference safe. Pure. */
export function cleanSessionName(raw: unknown, fallback: string): string {
  const s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return s || fallback;
}

export async function authSetup(rawUser: unknown, opts: SetupOpts = {}): Promise<string> {
  const loginUrl = String(opts.login_url || "").trim();
  if (!loginUrl) return "Error: login_url wajib (endpoint login lab).";
  if (!/^https?:\/\//i.test(loginUrl)) return "Error: login_url harus http(s).";
  if (!targetAllowed(loginUrl)) return "Error: SCOPE — login_url bukan lab milik owner / host engagement aktif.";
  const accounts = (Array.isArray(opts.accounts) ? opts.accounts : []).slice(0, MAX_ACCOUNTS);
  if (!accounts.length) return "Error: accounts wajib — mis. accounts=[{credential:\"admin:pass\", session:\"admin\"}, {credential:\"guest:pass\", session:\"guest\"}].";
  const lines: string[] = [`🔑 AUTH SETUP — ${loginUrl} (${accounts.length} akun)`];
  const ready: string[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i] || {};
    const cred = a.credential ? parseCredential(a.credential) : null;
    if (a.credential && !cred) {
      lines.push(`• [${i + 1}] ⛔ credential harus format "user:pass" — dilewati.`);
      continue;
    }
    const username = (cred?.username ?? a.username ?? "").trim();
    const password = cred?.password ?? a.password ?? "";
    const session = cleanSessionName(a.session, `account_${i + 1}`);
    if (!username || !password) {
      lines.push(`• [${i + 1}] ⛔ username/password kosong — dilewati.`);
      continue;
    }
    try {
      const res = await atoProve(rawUser, {
        login_url: loginUrl,
        username,
        password,
        session,
        user_field: opts.user_field,
        pass_field: opts.pass_field,
        body_template: opts.body_template,
        protected_url: opts.protected_url,
      });
      if (/^Error:/.test(res.trim())) {
        lines.push(`• [${i + 1}] ${username} → Error: ${res.split("\n")[0].slice(0, 120)}`);
        continue;
      }
      const cookies = readSessions(rawUser)[session]?.cookies ?? {};
      const names = Object.keys(cookies);
      if (!names.length) {
        lines.push(`• [${i + 1}] ${username} / ${maskPassword(password)} → login TANPA cookie sesi (cek field/URL) — "${session}" tidak siap.`);
        continue;
      }
      ready.push(session);
      lines.push(`• [${i + 1}] ${username} / ${maskPassword(password)} → sesi "${session}" SIAP (${names.slice(0, 4).join(", ")}).`);
    } catch (e) {
      lines.push(`• [${i + 1}] ${username} → gagal: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
    }
  }
  lines.push("");
  if (ready.length >= 2) {
    lines.push(`✅ Siap untuk exploit_chain: session_a=${ready[0]} session_b=${ready[1]} (bola_diff/auth_matrix/http_request juga bisa pakai).`);
  } else if (ready.length === 1) {
    lines.push(`ℹ️ 1 sesi siap ("${ready[0]}") — cukup untuk auth_bypass/ssrf/race; IDOR butuh 2 (tambah 1 akun lagi).`);
  } else {
    lines.push(`⛔ Tidak ada sesi siap — perbaiki login_url/field/kredensial lalu ulangi. Chain butuh sesi tidak akan jalan.`);
  }
  return lines.join("\n");
}
