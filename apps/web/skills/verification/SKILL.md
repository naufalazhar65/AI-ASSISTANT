# Skill: Verification

> Proof and verification — PoC replay, retest suite, severity calibration, CVSS scoring, and fix verification.

## Tools
- **poc_verify**: Replay a lead N× with response fingerprinting → determinism verdict
- **retest_run**: Regression retest suite (fix-verification in one command)
- **retest_add**: Add a retest case from a finding
- **retest_list**: List retest cases
- **cvss_score**: CVSS v3.1/v4.0 base score calculation
- **cvss4MacroVector**: CVSS v4.0 macrovector
- **platform_severity**: CVSS → HackerOne/Bugcrowd severity mapping
- **dup_check**: Check for duplicate findings
- **security_playbook**: Load pentest knowledge packs (85 packs)

## When to Use
- After finding a lead: prove determinism before finding_add
- When user says "verify", "PoC", "retest", "CVSS", "severity", "calibrate"
- Before reporting: ensure all findings have proof

## Rules
- poc_verify required before finding_add for high/critical findings
- retest_run verifies fix (🔴 still vulnerable / 🟢 patched / ⚪ error)
- CVSS v4.0 supported (CVSS:4.0/ vector)
- Never inflate severity without evidence

## Output Format
Use shared finding schema. Findings must include: expected, actual, cvssVector, evidence.

## Workflow
1. `poc_verify` → prove determinism (N× replay)
2. `retest_add` → create retest case from finding
3. `cvss_score` → calculate CVSS
4. `platform_severity` → map to platform severity
5. `retest_run` → verify fix after patch