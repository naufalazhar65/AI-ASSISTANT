# Skill: Recon

> Surface discovery and asset enumeration — subdomains, endpoints, tech stack, and JS bundle mining. Non-invasive OSINT + bounded active probing.

## Tools
- **recon_subdomains**: Passive subdomain enumeration (crt.sh + hackertarget fallback)
- **recon_params**: Passive public-archive URL/param mining (OTX, urlscan, Wayback)
- **recon_httpx**: Active live-host HTTP(S) probe (scope-gated)
- **recon_list**: Per-user recon cache (list previously discovered assets)
- **content_discover**: robots/sitemap/page links/JS endpoint mining + bounded path probe
- **js_mine**: Endpoints + secrets from JS bundles (values redacted)
- **js_deobfuscate**: Eval-free deobfuscation of webpack/obfuscator bundles + source-map restore
- **recon_dnsbrute**: DNS wordlist brute-force with wildcard detection
- **recon_ports**: Native TCP connect scan on common ports (scope-gated)
- **recon_takeover**: Passive CNAME-fingerprint takeover candidates

## When to Use
- Start of any pentest engagement on a new target
- When user says "scan", "recon", "find subdomains", "enumerate endpoints", "what's on this host"
- Before deeper testing: know the surface first

## Rules
- Passive sources (crt.sh, OTX, Wayback) are open to any domain (public OSINT)
- Active probing (recon_httpx, recon_ports, content_discover active path probe) is scope-gated: lab / engagement / PENTEST_LAB_TARGETS only
- Always record findings to target_brain after recon
- Never scan public third-party demo hosts (itsecgames.com, bWAPP online) — use local lab

## Output Format
Use the shared finding schema (findingSchema.ts) for any discovered asset worth reporting. Recon findings typically have severity "info" unless a misconfiguration is found (then use the appropriate severity + CVSS).

## Workflow
1. `recon_subdomains` → discover subdomains
2. `recon_httpx` → probe live hosts
3. `content_discover` → mine endpoints from live pages
4. `js_mine` → extract hidden API routes from bundles
5. `js_deobfuscate` → if bundles are obfuscated/minified
6. Record all discovered endpoints to `target_brain` for dedup across sessions