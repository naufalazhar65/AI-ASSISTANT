# Skill: Web

> Web vulnerability assessment — headers, cookies, TLS, CORS, CSP, cache deception, and passive/active web audit. OWASP Top 10 coverage for web apps.

## Tools
- **web_audit**: Passive header/cookie/TLS audit (headers, CSP, HSTS, cookies)
- **cors_audit**: CORS misconfiguration detection (reflected origin, credentials)
- **csp_audit**: CSP weakness analysis (unsafe-inline, unsafe-eval, missing directives)
- **cache_decep**: Web Cache Deception (decoy path → anon re-fetch)
- **cache_poison_prover**: Web Cache Poisoning (X-Forwarded-* matrix + fat GET)
- **bypass403**: 403/401 bypass matrix (path tricks, headers, verbs)
- **open_redirect_chain**: Open redirect bypass (param × payload matrix)
- **host_header_hunt**: Host header injection + reset poisoning
- **web_cache_poisoning** (playbook): detailed cache poisoning procedures

## When to Use
- After recon: testing the web surface for OWASP Top 10 issues
- When user says "audit headers", "check CORS", "web audit", "403 bypass", "cache poisoning"
- For any HTTP-based vulnerability class not covered by injection/auth/access skills

## Rules
- All tools are scope-gated (lab / engagement / PENTEST_LAB_TARGETS)
- Start with passive web_audit before active probing
- Record findings to target_brain after each confirmed issue
- Run poc_verify before finding_add (no finding without proof)

## Output Format
Use shared finding schema. Severity by CVSS band. Always include Expected/Actual behavior.

## Workflow
1. `web_audit` → baseline header/cookie/TLS posture
2. `cors_audit` + `csp_audit` → check CORS/CSP misconfigs
3. `cache_decep` → test cache deception
4. `bypass403` → test 403 bypass on protected paths
5. `open_redirect_chain` → test redirect params
6. `host_header_hunt` → test host header injection