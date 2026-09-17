<!--
Original Mia knowledge pack (no external source). Knowledge only — not code.
Mia tool mapping: probe→http_request (session/headers), callback→oast_create/oast_poll,
diff→poc_verify (baseline_url + expect_contains on the poisoned marker), evidence→evidence_capture,
track→hunt_log, report→finding_add + writeup.
-->
---
name: web-cache-poisoning
description: Unkeyed-input cache poisoning and cache deception — persistent XSS/redirect/open-redirect via shared caches and CDNs
---

# Web Cache Poisoning & Deception

A shared cache stores a response keyed on a subset of the request (usually method + path + Host + a few headers). Anything the response reflects that is **not part of the cache key** (an "unkeyed input") can be poisoned once and then served to everyone who hits that key. Cache deception is the mirror image: make the cache store a *private* response under a *public* URL.

## Attack Surface

- CDN/reverse-proxy caching (`Cache-Control`, `Age`, `X-Cache`, `CF-Cache-Status`, `X-Served-By`)
- Framework-level caches (Next.js ISR, Rails `actionpack-page_caching`, Django cache middleware)
- Default cacheable extensions: `.css`, `.js`, `.png`, `.svg`, `.ico`, `.woff2`, and library paths
- Redirect endpoints and error pages that get cached

## High-Value Targets

- Home/landing, login, signup, password-reset, 404/500 error pages
- JSON/API endpoints that echo headers (`/api/me`, `/api/config`)
- Any page an unauthenticated victim will load — a poisoned XSS there hits every visitor

## Reconnaissance

### Classify the cache

Send a request, then repeat it and inspect `Age`/`X-Cache`. `Age` increasing (or `X-Cache: HIT`) proves a shared cache sits in front of that key. Test the cache key by varying one header at a time and watching whether the cached response changes.

### Candidate unkeyed inputs

- Headers the app reflects: `X-Forwarded-Host`, `X-Forwarded-Scheme`, `X-Host`, `X-Forwarded-Server`, `X-Original-URL`, `X-Rewrite-URL`, `X-Forwarded-For`, `True-Client-IP`, `X-Wap-Profile`, `Accept-Language`
- Query parameters that are *parsed but not cached* (parameter cloaking): `/page?utm=1&callback=alert(1)` when only `utm` is in the key
- Fat GET (`GET` with a body), `X-HTTP-Method-Override`
- Path normalisation/encoding differences between the cache and the origin (`/p`, `/p/`, `/p%2f`, `/p;.js`, `/p/.css`, `/p?x`)

### Probes

Use a unique marker that is obviously attacker-controlled: a canary host (`<rand>.oast.<domain>`), a `callback=` value, or a unique string. Then verify it appears **verbatim** in the cached response.

## Key Vulnerabilities

### Header-driven poisoning

An origin that builds absolute URLs or canonical links from `X-Forwarded-Host`/`Host` will emit poisoned `<script src>`/`<link>`/`<base>` or a redirect `Location`. Poison once with your canary, then hit the same key *without* the header to prove everyone else gets it.

### Cache deception (must-not-store → stored)

`/account/profile/nonexistent.css` — if the cache keys on extension and the origin ignores the trailing segment (path normalisation), the authenticated HTML for `/account/profile` may be cached publicly. Confirm by fetching the same URL in a clean, unauthenticated session and checking for the private marker.

### Serving stale/private variants

- Missing `Vary` on a header the response depends on (`Vary: Cookie`, `Vary: Accept-Encoding`)
- `X-Cache-Key` quirks: cookies stripped, `Vary: User-Agent` collapsed
- `Cache-Control: public` on an authenticated response

### Parameter cloaking / normalisation gaps

- Semicolon or comma truncation: `?a=1;callback=BAD` cached as `a=1`
- Duplicate params: cache caches the first, origin uses the last (`?a=SAFE&a=BAD`)
- Encoding: `%00`, `%23`, `#` used to hide the malicious part from the cache key

## Testing Methodology

1. Identify the cache and its key (method, path, Host, `Vary`).
2. Enumerate unkeyed inputs one by one with a unique canary.
3. Confirm the canary is reflected in the response *and* unchanged when the input is removed (that is the definition of poisoning).
4. Verify persistence and blast radius: does the poisoned response go to a fresh session / different IP?
5. Prove impact concretely: XSS (`<script>`, `onerror=`), open redirect, `Set-Cookie` injection, or data disclosure.
6. Clean up: if you cannot fully un-poison, say so in the report (a live poisoned cache is a DoS for the client) and stop after the minimum proof.

## Validation

- `http_request` with the poisoning header, capture the raw response (`Cache-Status`, `Age`).
- Re-request the *same key without the header* and show the injected marker is still served → use `poc_verify` with `baseline_url` (clean) vs `url` (poisoned) and `expect_contains` for the marker.
- For deception, show a private value (name, email, token) served to a session that never authenticated.
- Out-of-band confirmation for blind cases: `oast_create` + the poisoned value pointing at your callback, then `oast_poll`.

## False Positives

- Header reflected only in the response *for the same request* and never reused from cache
- `Age` present but the response varies per user (`Vary: Cookie` respected)
- Marker appears only because you sent it in a *keyed* input (that is just normal behaviour)
- Private data visible because you are still authenticated (session mix-up, not cache deception)

## Impact

- Stored XSS for every visitor of a public page (mass account takeover via session/cookie theft)
- Open redirect on a trusted domain → phishing, OAuth code interception
- Disclosure of another user's private page/API response
- Full-site denial of service if the poisoned key cannot be invalidated

## Pro Tips

1. Pick the **highest-traffic key** that also reflects an unkeyed input — impact is proportional to traffic.
2. `X-Forwarded-Host` + a page that emits OG/meta tags is the classic winner.
3. Try `/path.css` and `/path/.js` style deception against every authenticated page.
4. A canary subdomain you control beats guessing; use the OAST helper.
5. Always report the exact cache key and whether a purge is needed.

## Summary

The bug is never "the app reflected a header" — it is "a shared cache stored that reflection". Prove the key, prove persistence without your input, then prove who receives it.
