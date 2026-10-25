# Skill: Access

> Access control testing — IDOR/BOLA, broken function-level authorization, path traversal, and privilege escalation.

## Tools
- **bola_diff**: Same request, two sessions A/B → identical-200 BOLA/IDOR signal
- **auth_matrix**: N-role permission matrix (admin/user/guest × endpoints)
- **path_traversal**: Path traversal / LFI / RFI (two-stage read marker, encoder battery)
- **idor_enum**: IDOR enumeration via level-param probing
- **bypass403**: 403/401 bypass matrix
- **exploit_chain** (chain=idor): automated IDOR chain (content_discover → bola_diff → finding)

## When to Use
- When target has user-specific resources (profiles, documents, orders)
- When user says "IDOR", "BOLA", "access control", "path traversal", "LFI", "privilege escalation"
- After auth: testing authorization boundaries

## Rules
- All active probes are scope-gated
- bola_diff requires two authenticated sessions (auth_setup first)
- path_traversal is read-only (two-stage marker, no RCE)
- Record confirmed access control bypass to target_brain + finding_add

## Output Format
Use shared finding schema. Access findings: A01 (Broken Access Control), CWE-639 (IDOR), CWE-22 (Path Traversal).

## Workflow
1. `auth_setup` → create sessions for testing
2. `bola_diff` → test IDOR between two accounts
3. `auth_matrix` → test role/permission matrix
4. `path_traversal` → test LFI/traversal on file params
5. `bypass403` → test 403 bypass on protected paths
6. `exploit_chain chain=idor` → automated IDOR chain