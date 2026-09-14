# Security playbooks

Pentest knowledge packs loaded on demand by the `security_playbook` tool
(`apps/web/src/lib/securityPlaybook.ts`). No executable code — Markdown only.

## Provenance & license

Adapted from **Strix** — <https://github.com/usestrix/strix> — licensed under
the **Apache License 2.0**. The upstream license applies to this adapted
content; keep this notice with the files. Changes made here: tool names mapped
to Mia's equivalents (`create_vulnerability_report`→`finding_add`,
`create_dependency_report`→`finding_add`, `load_skill`→`security_playbook`,
`record_coverage`/`agent_finish`→report/closure notes) and short `analysis`
edits for Mia's workflow.

## Layout

`<category>/<name>.md` with YAML frontmatter (`name`, `description`) + a
Markdown body. Categories: `analysis`, `custom`, `frameworks`, `protocols`,
`reconnaissance`, `technologies`, `tooling`, `vulnerabilities`.

Add a pack by dropping a file with that frontmatter into the matching folder,
then restart the server (packs are cached per process). `security_playbook`
with no arguments lists the catalog.
