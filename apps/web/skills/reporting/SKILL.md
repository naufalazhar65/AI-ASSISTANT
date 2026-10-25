# Skill: Reporting

> Report generation and finding management — markdown/PDF reports, writeups, evidence capture, and submission tracking.

## Tools
- **report_generate**: Generate markdown report from findings (per-target scoping)
- **report_save**: Save report to disk (.md)
- **report_pdf**: Render report as PDF (Playwright, professional template)
- **writeup**: Render submission-ready markdown from a finding + evidence
- **evidence_capture**: Capture raw HTTP + Playwright screenshot as evidence
- **finding_add**: Add a finding to the store (with auto-evidence + retest case)
- **finding_list**: List findings (per-target scoping)
- **finding_resolve**: Mark finding as resolved
- **finding_export**: Export findings (CSV/JSON/SARIF)
- **dup_check**: Check for duplicate findings (token-Jaccard similarity)
- **submission_track**: Track bug-bounty submissions (add/list/update/delete)
- **program_score**: ROI score for a bug-bounty program scope

## When to Use
- After testing: compile findings into a report
- When user says "report", "writeup", "PDF", "export findings", "track submission"
- For bug-bounty submission preparation

## Rules
- report_generate/save/pdf MUST include target param (prevents mixing findings from different targets)
- finding_add requires proof (poc_verify/retest) for high/critical severity
- Evidence must match the endpoint (urlMatch)
- Redact secrets/PII before report (redactEvidenceForReport)

## Output Format
Use shared finding schema. Reports use English for international platforms.

## Workflow
1. `finding_list target=<host>` → review findings
2. `dup_check` → check for duplicates
3. `report_generate target=<host>` → generate markdown
4. `report_pdf target=<host>` → render PDF
5. `writeup` → submission-ready writeup per finding
6. `submission_track` → track platform submission