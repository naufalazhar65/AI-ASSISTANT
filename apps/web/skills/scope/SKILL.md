# Skill: Scope

> Scope management — engagement creation, authorization, target validation, policy auto-approve, and scope import.

## Tools
- **engagement_create**: Create engagement (authorization URL + scope + out-of-scope)
- **engagement_list**: List engagements
- **engagement_close**: Close engagement
- **engagement_targets**: Worklist of all in-scope hosts of active engagements
- **scope_import**: Heuristic parse of program Targets text → in/out-of-scope
- **policy_set**: Per-engagement auto-approve for vetted subset (read/write only, scope-gated)
- **policy_show**: Show current policy
- **lab_add**: Declare a host as owner's own lab (persistent, no env edit)
- **targetAllowed**: Check if target is in scope (internal)
- **isLabTarget**: Check if target is owner's lab (internal)

## When to Use
- Before any pentest: define scope and authorization
- When user says "scope", "engagement", "authorization", "policy", "lab add"
- For bug-bounty: import program scope, create engagement

## Rules
- engagement_create requires authorization (URL or policy text)
- Active scan only to in-scope hosts (targetAllowed gate)
- policy_set only for read/write risk tools, never delete/transaction/external
- lab_add requires owner declaration (no env edit needed)
- Never scan out-of-scope targets

## Output Format
Use shared finding schema. Scope findings: engagement metadata, not vulnerabilities.

## Workflow
1. `scope_import` → parse program targets
2. `engagement_create` → create engagement with authorization
3. `engagement_targets` → get worklist of in-scope hosts
4. `policy_set` → auto-approve vetted tools for lab targets
5. `lab_add` → declare additional owner labs