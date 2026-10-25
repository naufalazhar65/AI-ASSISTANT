# Skill: Logic

> Business logic and workflow testing — state-transition fuzzing, race conditions, CSRF, and workflow abuse.

## Tools
- **workflow_fuzz**: Business-logic state-transition fuzzer (skip/repeat/reorder/value mutations)
- **race_attack**: Race condition detection (parallel requests + nonce uniques)
- **csrf_prove**: CSRF proof (PoC generation + token analysis)
- **exploit_chain** (chain=race): automated race condition chain
- **exploit_chain** (chain=session_fixation): session fixation chain

## When to Use
- When target has transactional flows (checkout, transfer, refund, registration)
- When user says "business logic", "race condition", "CSRF", "workflow", "state machine"
- After injection/auth: testing application logic

## Rules
- workflow_fuzz requires a defined happy-path flow (≥2 steps)
- race_attack uses nonce uniqueness to prove duplicate creation
- All probes are scope-gated
- Never exploit race conditions destructively (use benign markers)

## Output Format
Use shared finding schema. Logic findings: A04 (Insecure Design), CWE-840 (Business Logic), CWE-362 (Race Condition).

## Workflow
1. Define happy-path flow (login → cart → checkout → refund)
2. `workflow_fuzz` → mutate flow (skip/repeat/reorder/value)
3. `race_attack` → test parallel execution
4. `csrf_prove` → test CSRF on state-changing endpoints
5. Record findings to target_brain