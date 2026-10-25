# Skill: Client

> Client-side security — DOM XSS taint analysis, DOM-XSS dynamic proof, prototype pollution, and client-side vulnerability classes.

## Tools
- **dom_taint**: DOM XSS taint analysis (source → sink tracing in one file)
- **dom_xss_prove**: Dynamic DOM-XSS proof in headless Chromium
- **prototype_pollution**: Prototype pollution testing
- **xss_hunt**: XSS proof (static taint + dynamic DOM proof)
- **js_mine**: Endpoints + secrets from JS bundles
- **js_deobfuscate**: Eval-free deobfuscation + source-map restore

## When to Use
- When target is a SPA or has heavy client-side JavaScript
- When user says "DOM XSS", "client-side", "prototype pollution", "JS bundle"
- After recon: analyzing client-side attack surface

## Rules
- dom_taint is static analysis (no network) — always verify manually before finding_add
- dom_xss_prove uses headless Chromium (scope-gated)
- js_mine/js_deobfuscate are read-only (scope-gated for active fetching)
- Record confirmed client-side XSS to target_brain + finding_add

## Output Format
Use shared finding schema. Client findings: A03 (Injection/XSS), CWE-79 (XSS), CWE-1321 (Prototype Pollution).

## Workflow
1. `js_mine` → extract endpoints/secrets from bundles
2. `js_deobfuscate` → if bundles are obfuscated
3. `dom_taint` → trace source → sink
4. `dom_xss_prove` → dynamic proof in Chromium
5. `prototype_pollution` → test __proto__ pollution