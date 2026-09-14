// Shared SSRF guard for every tool that fetches a URL from the server
// (fetch_url, browser_* / browser_use_*, library link capture, web_audit).
// Public http(s) only — internal/loopback/private/link-local/metadata are refused.
//
// Kept dependency-free (pure URL) and outside tools.ts so the Playwright modules
// can import it without creating a static import cycle.

/** IPv4 loopback / private / link-local / "this host" prefixes. */
const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|0\.|169\.254\.)/;

/** Split an URL hostname into the bare literal (IPv6 brackets stripped) + kind. */
function bareHost(hostname: string): { host: string; ipv6: boolean } {
  const h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return { host: h.slice(1, -1), ipv6: true };
  return { host: h, ipv6: h.includes(":") };
}

/**
 * Refuse non-http(s) schemes and internal/private/link-local/metadata hosts.
 * Throws with a user-safe message; returns the parsed URL on success.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http/https URLs are allowed");
  const { host, ipv6 } = bareHost(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("internal addresses are not fetchable");
  }
  if (ipv6) {
    // ::/128, ::1, ::ffff:… IPv4-mapped, fc00::/7 ULA, fe80::/10 link-local
    // (incl. fec0:: site-local) — none are public unicast.
    if (host.startsWith("::") || /^f[cd]/.test(host) || /^fe/.test(host)) {
      throw new Error("private network addresses are not fetchable");
    }
  } else {
    if (PRIVATE_V4.test(host)) throw new Error("private network addresses are not fetchable");
    if (host.startsWith("172.")) {
      const seg = Number(host.split(".")[1]);
      if (seg >= 16 && seg <= 31) throw new Error("private network addresses are not fetchable");
    }
    if (!host.includes(".")) throw new Error("host does not look public"); // crude TLD sanity
  }
  return url;
}
