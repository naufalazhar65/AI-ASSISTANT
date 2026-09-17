// Technology fingerprinting from a live HTTP response (headers + HTML markers).
// Pure detection is split from the fetch so callers that already have a response
// (tech_watch diffing, pentest_scan's whatweb fallback) share ONE definition of
// "what counts as a detected technology" — no external binary required.

/** Detect technologies from response headers + an HTML snippet. Pure — unit-tested.
 *  Deliberately conservative: only well-known markers, no guessing. */
export function detectTech(headers: Record<string, string>, body: string): string[] {
  const out = new Set<string>();
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const b = (body || "").slice(0, 200_000);

  const server = h["server"] || "";
  if (server) out.add(`server:${server.slice(0, 80)}`);
  if (h["x-powered-by"]) out.add(`x-powered-by:${h["x-powered-by"].slice(0, 60)}`);
  if (h["x-generator"]) out.add(`x-generator:${h["x-generator"].slice(0, 60)}`);
  if (h["x-aspnet-version"]) out.add(`aspnet:${h["x-aspnet-version"]}`);
  if (h["x-drupal-cache"] || h["x-drupal-dynamic-cache"]) out.add("drupal");
  if (h["x-rack-cache"] || /_rails|rails/i.test(h["x-powered-by"] || "")) out.add("rails");
  if (h["cf-ray"]) out.add("cloudflare");

  const markers: [RegExp, string][] = [
    [/wp-content|wp-includes|\/wp-json/i, "wordpress"],
    [/_next\/static|__NEXT_DATA__/i, "next.js"],
    [/data-reactroot|react(?:\.production)?\.min\.js/i, "react"],
    [/ng-version|angular/i, "angular"],
    [/csrf-token" content=/i, "rails"],
    [/laravel_session|XSRF-TOKEN/i, "laravel"],
    [/django|csrfmiddlewaretoken/i, "django"],
    [/__VIEWSTATE|__EVENTVALIDATION/i, "asp.net webforms"],
    [/jsessionid|Spring/i, "java/spring"],
    [/shopify/i, "shopify"],
    [/wp-json|drupal/i, "drupal"],
    [/firebaseio\.com|firebaseapp\.com/i, "firebase"],
  ];
  for (const [re, name] of markers) if (re.test(b)) out.add(name);

  // Version hints (only when explicit).
  const gen = b.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,80})["']/i);
  if (gen) out.add(`generator:${gen[1]}`);
  const wp = b.match(/content=["']WordPress ([\d.]+)["']/i);
  if (wp) out.add(`wordpress:${wp[1]}`);
  return [...out].slice(0, 20);
}

/** One bounded GET → status + headers + detected tech. */
export async function fetchFingerprint(url: string): Promise<{ status: number; headers: Record<string, string>; tech: string[] }> {
  const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = (await res.text()).slice(0, 200_000);
  return { status: res.status, headers, tech: detectTech(headers, body) };
}
