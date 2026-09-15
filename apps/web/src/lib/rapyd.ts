// Rapyd sandbox API client — computes the HMAC request signature and sends the
// call through security.httpRequest (scope guard + history + polite delay).
// RoE Rapyd: API testing ONLY in the sandbox environment, so non-sandbox hosts
// are refused. Secrets are never logged (auditLog redacts rapyd_request args).
import { createHmac } from "node:crypto";
import { targetAllowed, httpRequest } from "./security";

/** Pure: Rapyd signature = BASE64(HEX(HMAC_SHA256(secret, lower(method)+path+salt+timestamp+access_key+secret+body))). */
export function rapydSign(method: string, path: string, body: string, accessKey: string, secretKey: string, salt: string, timestamp: string | number): string {
  const toSign = method.toLowerCase() + path + salt + String(timestamp) + accessKey + secretKey + body;
  const hex = createHmac("sha256", secretKey).update(toSign).digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

const SALT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function rapydSalt(len = 12): string {
  let s = "";
  for (let i = 0; i < len; i++) s += SALT_CHARS[Math.floor(Math.random() * SALT_CHARS.length)];
  return s;
}

export async function rapydRequest(
  rawUser: unknown,
  opts: { method?: string; path: string; body?: string; access_key: string; secret_key: string; base?: string }
): Promise<string> {
  const accessKey = (opts.access_key || "").trim();
  const secretKey = (opts.secret_key || "").trim();
  if (!accessKey || !secretKey) return "Error: access_key & secret_key sandbox wajib.";
  const method = (opts.method || "GET").toUpperCase();
  const base = (opts.base || "https://sandboxapi.rapyd.net").replace(/\/$/, "");
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  let url: URL;
  try {
    url = new URL(base + path);
  } catch {
    return "Error: base/path tidak valid.";
  }
  if (!/sandbox/i.test(url.hostname)) {
    return "Error: RoE Rapyd — API testing HANYA di sandbox (sandboxapi.rapyd.net), bukan produksi.";
  }
  if (!targetAllowed(url.toString())) return "Error: SCOPE — host API di luar engagement (tambahkan *.rapyd.net ke scope).";
  let bodyStr = "";
  if (opts.body) {
    try {
      bodyStr = JSON.stringify(JSON.parse(opts.body)); // Rapyd: body tanpa whitespace
    } catch {
      bodyStr = opts.body;
    }
  }
  const salt = rapydSalt();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = rapydSign(method, url.pathname + url.search, bodyStr, accessKey, secretKey, salt, timestamp);
  const headers = { access_key: accessKey, salt, timestamp, signature, "content-type": "application/json", idempotency: `${Date.now()}${salt}` };
  return httpRequest({ url: url.toString(), method, headers, body: method === "GET" || method === "HEAD" ? undefined : bodyStr }, rawUser);
}
