# Skill: Injection

> Injection vulnerability testing — SQLi, NoSQLi, XSS, SSTI, XXE, command injection, LDAP injection, XPath injection, XSLT injection, and prototype pollution.

## Tools
- **param_fuzz**: Parameter fuzzing (XSS/SQLi/SSTI/redirect/cmdi/xpath/ldap/xslt payloads)
- **sqlmap_scan**: SQL injection via sqlmap (scope-gated, sandbox template path)
- **nosql_hunt**: NoSQL injection (operator injection, nested syntax)
- **xss_hunt**: XSS proof (static taint + dynamic DOM proof)
- **dom_taint**: DOM XSS taint analysis (source → sink tracing)
- **dom_xss_prove**: Dynamic DOM-XSS proof in headless Chromium
- **ssti_enum**: SSTI engine fingerprint (Jinja2/Twig/Freemarker/etc.)
- **blind_cmdi**: Blind command injection (OAST + time-based)
- **xxe_chain**: XXE (file-read + OAST OOB)
- **prototype_pollution**: Prototype pollution testing
- **param_miner**: Unkeyed param/header discovery

## When to Use
- When target accepts user input (search, forms, API params)
- When user says "XSS", "SQLi", "injection", "SSTI", "XXE", "command injection"
- After recon: testing input handling

## Rules
- All active probes are scope-gated
- param_fuzz is the entry point for quick injection scanning
- poc_verify required before finding_add
- Never send destructive payloads (DROP TABLE, rm -rf) — use benign markers

## Output Format
Use shared finding schema. Injection findings: A03 (Injection), CWE-79 (XSS), CWE-89 (SQLi), CWE-94 (Code Injection).

## Workflow
1. `param_fuzz` → quick injection scan on all params
2. `sqlmap_scan` → deep SQLi on suspicious params
3. `xss_hunt` / `dom_xss_prove` → XSS proof
4. `ssti_enum` → SSTI engine fingerprint
5. `blind_cmdi` → blind command injection
6. `xxe_chain` → XXE testing
7. `nosql_hunt` → NoSQL injection