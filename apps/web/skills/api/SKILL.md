# Skill: API

> API security testing — REST/GraphQL/OpenAPI spec mining, endpoint enumeration, parameter discovery, and API-specific vulnerability classes.

## Tools
- **api_spec**: Parse OpenAPI/Postman JSON → endpoint list
- **graphql_probe**: GraphQL introspection + field-suggestion mining
- **graphql_hunt**: Advanced GraphQL (alias batching, depth probe, suggestion mining)
- **api_hunt**: OpenAPI spec → enumerate endpoints → unauth probe
- **param_miner**: Unkeyed param/header discovery (Param-Miner-style)
- **param_fuzz**: Parameter fuzzing (XSS/SQLi/SSTI/redirect/cmdi/xpath/ldap/xslt payloads)
- **param_discover**: Common parameter name discovery (~100 names)
- **recon_params**: Passive public-archive URL/param mining
- **js_mine**: API routes hidden in JS bundles

## When to Use
- When target exposes REST API, GraphQL, or OpenAPI spec
- When user says "API test", "GraphQL", "endpoint enumeration", "parameter mining"
- After recon: deeper API surface analysis

## Rules
- api_spec requires a JSON spec URL or pasted content
- graphql_probe/hunt are scope-gated for active probing
- param_miner and param_fuzz are scope-gated
- Always record discovered endpoints to target_brain

## Output Format
Use shared finding schema. API findings typically: IDOR (A01), Broken Auth (A07), Excessive Data Exposure (A03).

## Workflow
1. `api_spec` / `graphql_probe` → discover API surface
2. `param_miner` → find unkeyed params/headers
3. `param_fuzz` → fuzz discovered params
4. `api_hunt` → unauth probe all endpoints
5. Record findings to target_brain