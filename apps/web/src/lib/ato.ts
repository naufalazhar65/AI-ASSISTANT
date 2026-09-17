// Credential → login → authenticated-access prover (the "ATO chain").
//
// A leak of plaintext credentials is only *potential* impact until someone logs
// in with them. This tool does exactly that against the owner's own lab /
// authorized engagement host: POST the credential, keep the session cookies,
// then fetch a protected page with that session and report both steps as
// evidence ready for `finding_add`.
//
// Safety: scope is enforced by `httpRequest` (targetAllowed) for EVERY hop; the
// password is never echoed back (only a masked form), so it does not leak into
// memory, logs or the chat.

import { httpRequest, targetAllowed } from "./security";
import { readSessions } from "./httpSession";

export type AtoOpts = {
  login_url: string;
  username?: string;
  password?: string;
  /** Shorthand `user:pass`, handy when the leak dumped them as one string. */
  credential?: string;
  protected_url?: string;
  user_field?: string;
  pass_field?: string;
  /** Raw body template using {{username}} / {{password}} (form-encoded logins). */
  body_template?: string;
  session?: string;
};

/** `user:pass` → parts. Pure. */
export function parseCredential(spec: string): { username: string; password: string } | null {
  const s = (spec || "").trim();
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  const username = s.slice(0, i).trim();
  const password = s.slice(i + 1).trim();
  return username && password ? { username, password } : null;
}

/** Login request body (JSON by default, or the caller's template). Pure. */
export function buildLoginBody(opts: { username: string; password: string; user_field?: string; pass_field?: string; body_template?: string }): string {
  if (opts.body_template) {
    return opts.body_template.replace(/\{\{\s*username\s*\}\}/g, opts.username).replace(/\{\{\s*password\s*\}\}/g, opts.password);
  }
  return JSON.stringify({ [opts.user_field || "username"]: opts.username, [opts.pass_field || "password"]: opts.password });
}

/** Masked credential label for evidence output (never the raw password). Pure. */
export function maskPassword(password: string): string {
  const p = password || "";
  if (p.length <= 2) return "••";
  return `${p.slice(0, 2)}${"•".repeat(Math.min(8, p.length - 2))}`;
}

export type AtoVerdict = { ok: boolean; label: string; proof: string };

/**
 * Judge the chain from the two responses. Pure.
 * `protectedLooksProtected` is false when the "protected" page is itself a login
 * form (i.e. the session did not actually unlock anything).
 */
export function atoVerdict(x: { loginStatus: number; sessionGot: boolean; protectedStatus: number | null; protectedLooksProtected: boolean }): AtoVerdict {
  const loginOk = x.loginStatus >= 200 && x.loginStatus < 400;
  if (!loginOk) {
    return { ok: false, label: "KREDENSIAL DITOLAK", proof: `login membalas ${x.loginStatus}` };
  }
  if (!x.sessionGot) {
    return { ok: false, label: "LOGIN OK TAPI TANPA SESI", proof: "tidak ada cookie sesi yang tersimpan (endpoint mungkin stateless)" };
  }
  if (x.protectedStatus === null) {
    return { ok: true, label: "LOGIN + SESI TERBUKTI", proof: "cookie sesi tersimpan (beri protected_url untuk membuktikan akses)" };
  }
  if (x.protectedStatus >= 200 && x.protectedStatus < 300 && x.protectedLooksProtected) {
    return { ok: true, label: "ACCOUNT TAKEOVER TERBUKTI", proof: `halaman terlindungi dapat diakses dengan sesi ini (${x.protectedStatus})` };
  }
  return {
    ok: false,
    label: "LOGIN OK, TAPI TIDAK MEMBUKA HALAMAN TERLINDUNGI",
    proof: `halaman terlindungi membalas ${x.protectedStatus}${x.protectedLooksProtected ? "" : " (masih form login)"}`,
  };
}

/** A page is treated as needing auth when it is not itself a password form. */
export function looksLikeLoginForm(body: string): boolean {
  return /type\s*=\s*["']password["']/i.test(body) || /name\s*=\s*["'](password|passwd|pwd)["']/i.test(body);
}

/** Prove (or disprove) an ATO chain with a leaked credential. */
export async function atoProve(rawUser: unknown, opts: AtoOpts): Promise<string> {
  const loginUrl = (opts.login_url || "").trim();
  if (!loginUrl) return "Error: login_url wajib.";
  if (!targetAllowed(loginUrl)) return "Error: SCOPE — login_url bukan lab milik owner / host engagement aktif.";
  const cred = opts.credential ? parseCredential(opts.credential) : null;
  const username = (cred?.username ?? opts.username ?? "").trim();
  const password = cred?.password ?? opts.password ?? "";
  if (!username || !password) return 'Error: beri `username`+`password`, atau `credential` dengan format "user:pass".';
  const protectedUrl = (opts.protected_url || "").trim();
  if (protectedUrl && !targetAllowed(protectedUrl)) return "Error: SCOPE — protected_url di luar izin.";

  const session = opts.session?.trim() || "ato";
  const body = buildLoginBody({ username, password, user_field: opts.user_field, pass_field: opts.pass_field, body_template: opts.body_template });
  const isForm = !!opts.body_template && !/^\s*\{/.test(opts.body_template);
  const login = await httpRequest(
    {
      url: loginUrl,
      method: "POST",
      headers: { "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json" },
      body,
      saveSession: session,
    },
    rawUser
  );
  const loginStatus = Number(/->\s*(\d{3})/.exec(login)?.[1] ?? 0);

  const cookies = readSessions(rawUser)[session]?.cookies ?? {};
  const cookieNames = Object.keys(cookies);
  const sessionGot = cookieNames.length > 0;

  let protectedStatus: number | null = null;
  let protectedLooksProtected = false;
  let protectedSnippet = "";
  if (protectedUrl) {
    const res = await httpRequest({ url: protectedUrl, method: "GET", session }, rawUser);
    protectedStatus = Number(/->\s*(\d{3})/.exec(res)?.[1] ?? 0);
    const bodyPart = res.split("\n\n").slice(1).join("\n\n");
    protectedLooksProtected = !looksLikeLoginForm(bodyPart);
    protectedSnippet = bodyPart.replace(/\s+/g, " ").slice(0, 300);
  }

  const verdict = atoVerdict({ loginStatus, sessionGot, protectedStatus, protectedLooksProtected });
  const lines = [
    `🔓 ATO PROVE ${verdict.ok ? "✅" : "❌"} ${verdict.label}`,
    `login : POST ${loginUrl} (field ${opts.user_field || "username"}/${opts.pass_field || "password"}) → ${loginStatus || "?"}`,
    `kredensial : ${username} / ${maskPassword(password)}`,
    `sesi  : ${sessionGot ? `tersimpan "${session}" (${cookieNames.slice(0, 4).join(", ")})` : "tidak ada cookie"}`,
    protectedUrl ? `akses : GET ${protectedUrl} → ${protectedStatus ?? "?"}${protectedSnippet ? `\n         ${protectedSnippet}` : ""}` : "",
    `putusan: ${verdict.label} — ${verdict.proof}`,
    protectedUrl ? "" : "(beri protected_url, mis. /api/admin-data atau halaman panel, untuk membuktikan aksesnya)",
    `Lanjutan: pakai session="${session}" di http_request/bola_diff untuk menguji sebagai user itu.`,
  ].filter(Boolean);
  return lines.join("\n");
}
