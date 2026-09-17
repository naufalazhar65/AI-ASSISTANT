<!--
Original Mia knowledge pack (no external source). Knowledge only — not code.
Mia tool mapping: header matrix→http_request (headers=…), baseline diff→poc_verify,
cache angle→playbook web-cache-poisoning, reset-link angle→playbook account-takeover,
OAST→oast_create/oast_poll, log→hunt_log, report→finding_add + writeup.
-->
---
name: host-header-injection
description: Host and X-Forwarded-* header attacks — reset-link poisoning, cache poisoning, routing/SSRF bypass, allowlist evasion
---

# Host Header Injection

Applications trust the incoming `Host` (and `X-Forwarded-*`) to build absolute URLs, decide which vhost/tenant to serve, and authorise redirects. Anywhere that trust is not validated against an allowlist, an attacker who can influence those headers changes the app's behaviour — often with a legitimate email or cached response as the delivery vehicle.

## Attack Surface

- Any absolute URL the server emits: password-reset links, invite/verify links, redirects (`Location`), canonical/OG/meta tags, `Set-Cookie` `Domain`, CORS `Access-Control-Allow-Origin`
- Virtual-host routing / tenant resolution (`X-Forwarded-Host`, `X-Forwarded-Server`, `X-Original-URL`, `X-Rewrite-URL`)
- Server-side fetchers and webhooks that call back the `Host`
- Shared caches in front of the app (see the cache-poisoning playbook)

## High-Value Targets

- Password reset / magic-link / email-verification emails
- OAuth/OIDC callback and logout URLs
- Multi-tenant dashboards (`tenant.example` resolution)
- Redirectors and language/locale switchers

## Reconnaissance

Build a header matrix and observe how the response (and any generated link) changes:

| Header | Purpose |
| --- | --- |
| `Host` | Primary vhost |
| `X-Forwarded-Host` | Common absolute-URL source |
| `X-Forwarded-Server` | Less-filtered alias |
| `X-Original-URL`, `X-Rewrite-URL` | Path override in some proxies |
| `X-Forwarded-Proto`, `X-Forwarded-Scheme` | Scheme override → redirect loops |
| `X-Forwarded-For`, `True-Client-IP` | Trusted-IP bypass |
| `Forwarded: host=…` | RFC 7239 form |

Use a unique canary (`<rand>.oast.<domain>`) so any reflection is easy to spot and confirm out-of-band. Send several `Host`/`X-Forwarded-Host` values in one request and note which one wins (first vs last is a fingerprint of the proxy).

## Key Vulnerabilities

### Reset-link / email poisoning

Request a password reset with `X-Forwarded-Host: attacker.tld`. The victim receives a mail that is genuinely from the application but whose link points at the attacker's host carrying the reset token. Deliver a real mailbox (`oast_create`) to prove the token arrives — this is the highest-impact variant.

### Cache poisoning via `Host`

If a 3xx/HTML response built from `Host` is cached under a key that ignores the header, the poisoned redirect/script is served to every visitor. Pair with the cache-poisoning playbook and prove persistence by re-requesting without the header.

### Routing and access-control bypass

- Sniffing vhosts: `Host: internal.example` may serve an admin panel normally hidden by the edge
- Access rules keyed on `X-Forwarded-For`/`True-Client-IP` (trusting a client-supplied header) → bypass IP allowlists
- `X-Original-URL`/`X-Rewrite-URL` path overrides that skip proxy-level authorization
- SSRF: an internal fetcher that calls back the supplied `Host`

### Allowlist evasion

Naive validators compare substrings or check only the start of the value. Try:

- `attacker.tld`, `trusted.example.attacker.tld`, `attacker.tld#trusted.example`
- `trusted.example\@attacker.tld`, `trusted.example%0d%0aX: y`
- Port tricks (`trusted.example:80@attacker.tld`), trailing dot (`trusted.example.`), case/IDN variants
- Missing-port default (`Host: trusted.example:evil`)

## Testing Methodology

1. Capture a baseline response per sensitive endpoint.
2. Re-send with each candidate header, one at a time, then combined; diff the output (`http_history`).
3. Prefer targets that **emit a link** (reset, invite) — a reflected URL in a machine-generated message is the proof.
4. Test absolute-URL construction sites: redirects, `Set-Cookie` domain, CORS origin, canonical tags.
5. Check the cache: if the poisoned response is cacheable, prove persistence for a *different* client.
6. Verify every claim with a fresh, unauthenticated session.

## Validation

- Reset poisoning: raw outgoing email (headers + body) showing your canary host in the link, plus proof that the token in that link resets the account.
- Redirect poisoning: `Location` containing your host from a request whose `Host`/`X-Forwarded-Host` you set.
- Cache angle: `poc_verify` with `baseline_url` (clean) vs the header-poisoned URL, asserting your marker via `expect_contains`.
- Access-control bypass: before/after status and body showing a rule was skipped using a forged forwarding header.

## False Positives

- Applications that hard-code a configured base URL (the correct fix) — no reflection at all
- Reflections that are escaped/encoded and never used to build a destination
- A `Host` that is accepted but the edge rewrites it before the app sees it (verify with the canary)
- Multi-tenant routing that validates against a registry (unknown host → 404)

## Impact

- Account takeover through reset-link poisoning (highest severity variant)
- Persistent XSS/redirect via cache poisoning, affecting every visitor of a key
- Authorization bypass (IP allowlists, admin vhosts, proxy rules)
- Internal SSRF reachability from a server-side callback

## Pro Tips

1. Always try `X-Forwarded-Host` before `Host` — apps often validate one and trust the other.
2. The canary subdomain is the whole game: use it in every payload so OAST can confirm blind cases.
3. Check `Set-Cookie: Domain=` too; a poisoned domain can silently drop or widen a session cookie.
4. Combining with an open redirect gives a fully controlled link chain.
5. Fix guidance: pin the base URL from config, validate the host against an allowlist, and never trust `X-Forwarded-*` unless the proxy immediately overwrites it.

## Summary

The question is not "does the app echo my Host header" but "does my Host header decide where a victim's email link, cache entry, or authorization check goes?" Prove the destination change, not the reflection.
