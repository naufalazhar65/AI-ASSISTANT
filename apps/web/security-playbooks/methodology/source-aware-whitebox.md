<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: source-aware-whitebox
description: Playbook koordinasi white-box source-aware — triage statis (semgrep/AST/secret/CVE) dipakai memandu validasi dinamis. Static = hipotesis sampai divalidasi.
---

# Source-Aware White-Box Coordination (Mia)

Dipakai saat source tersedia. Tujuannya menaikkan coverage white-box dengan menggabungkan triage source-aware dan validasi dinamis.

## Alur

1. **Peta source cepat** sebelum eksploitasi dalam: minimal satu pass struktural (AST) bila tersedia (`sg`/tree-sitter via `exec`), di-scope ke path relevan.
2. **Triage statis pass pertama** untuk peringkat path berisiko: `sast_scan` (semgrep `p/default`+`p/secrets`).
3. **Pakai output triage** untuk memprioritaskan validasi PoC dinamis.
4. **Evidence-driven**: tak ada laporan tanpa validasi.

## Stack triage source-aware

- `sast_scan` (semgrep) — triage cepat security-first + pola kustom
- **AST** (`ast-grep`/`sg`, `tree-sitter`) via `exec` — hunting struktural & pemetaan repo (bila terpasang; `brew install ast-grep`)
- `secret_scan` (+ `gitleaks`/`trufflehog` bila terpasang) — deteksi secret working-tree & history
- `trivy_scan` — dependency, misconfig, license

Target coverage per repo: 1 pass `sast_scan` + 1 pass AST (bila ada) + 1 pass secret + 1 pass `trivy_scan`.

## Guardrail validasi

- Temuan **statis = hipotesis** sampai divalidasi.
- **Bukti eksploitasi dinamis tetap wajib** sebelum `finding_add` tervalidasi (kecuali temuan dependency CVE → `dep_audit`/`finding_add` A06, atau static-only yang dilaporkan confidence medium/low + gap disebut).
- Output scanner ringkas, dedup, dan dipetakan ke lokasi kode konkret (`file:line`).
