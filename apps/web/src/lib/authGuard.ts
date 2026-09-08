// Web auth (Fase 5, lightweight single-owner gate). When AUTH_TOKEN is set,
// the web app and its /api/* endpoints require either the `mia_auth` cookie
// (set by POST /api/auth/login with the right PIN) or an `Authorization: Bearer`
// header. Edge-safe (no node imports) so it can be used from middleware.ts.
//
// Without AUTH_TOKEN everything is open (default personal-LAN deploy). Bots use
// runAssistantTurn directly (no HTTP-to-self), so they are unaffected.

const COOKIE = "mia_auth";
/** Paths that must stay reachable without auth (login, external callbacks…). */
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/webhook", "/api/spotify/", "/api/gmail/"];

export function authToken(): string | undefined {
  const t = process.env.AUTH_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

export function authEnabled(): boolean {
  return authToken() !== undefined;
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export function isAuthorized(
  cookieValue: string | null | undefined,
  bearerToken: string | null | undefined,
  expected: string | undefined = authToken(),
): boolean {
  if (!expected) return true;
  if (cookieValue && cookieValue === expected) return true;
  if (bearerToken && bearerToken === expected) return true;
  return false;
}

export function bearerFrom(header: string | null | undefined): string | null {
  if (header && header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export { COOKIE };