<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: scan-modes
description: Empat preset kedalaman assessment Mia — quick (high-impact, breadth), standard (sistematis), deep (exhaustive + chaining), diff (hanya perubahan PR/commit). Pilih sesuai waktu/tujuan; mode mengubah luas, BUKAN menurunkan standar bukti.
---

# Scan Modes (Mia)

Mode mengubah **luas & kedalaman**, bukan standar bukti. Semua mode tetap: validasi sebelum `finding_add`, pass counterevidence & severity-calibration.

## quick — high-impact, breadth
Time-boxed. Pilih breadth daripada depth; lewati enumerasi menyeluruh.
- **Whitebox:** fokus perubahan terbaru (`exec` `git diff`/log) — bug baru paling mungkin di situ. `sast_scan` pada file berubah, lalu AST ter-scope.
- **Blackbox:** petakan auth & alur kritis; uji yang langsung terjangkau (`recon_httpx`, `web_audit`, `pentest_scan` terarah). Lewati content discovery dalam.
- Prioritaskan: **auth bypass → broken access control (IDOR/privesc) → RCE (command/SSTI/deserialization) → SQLi → SSRF → secret terekspos.**

## standard — sistematis (default review)
- **Whitebox:** peta struktur/route/entry-point; `sast_scan` prioritas flow berisiko; identifikasi pola arsitektur; trace input (form/API/upload/header/cookie); review auth & authz; `trivy_scan`/`secret_scan`; pahami data model.
- **Blackbox:** crawl fitur, enumerasi endpoint/parameter, fingerprint stack, map role (`recon_subdomains`→`recon_httpx`→`pentest_scan`).
- Fase 2: pahami **business logic** (alur kritis, batas role) sebelum menguji.

## deep — exhaustive + chaining (pra-rilis)
Coverage & depth maksimum; rangkai temuan for maximum impact.
- **Whitebox:** peta tiap file/code path; triage source-aware luas (`sast_scan`, AST, `secret_scan`, `trivy_scan`); trace semua entry point → DB; dokumentasikan semua mekanisme auth; map authz; review job latar/async, serialization, file handling, deployment assumptions.
- **Blackbox:** subdomain enumeration penuh (`recon_subdomains`), port scan (`pentest_scan` nmap), content discovery (`ffuf`/`gobuster`), fingerprint semua aset.
- Rangkai: temuan rendah + temuan lain → dampak tinggi.

## diff — hanya perubahan (PR/commit/branch)
Review **change set**, bukan repo. **In scope:** masalah yang diperkenalkan/diperkenalkan-ulang/baru-terjangkau oleh perubahan ini.
- Pre-existing weakness yang **kini terjangkau** diff (sink lama, caller baru).
- Helper/guard/route bersama yang **dilemahkan** diff → perluas ke sibling call site.
- Kontrol yang **dihapus/dipersempit** (mis. cek otorisasi dihapus) = temuan walau tanpa sink baru.
- Perubahan perilaku yang membatalkan asumsi (tipe dilonggarkan, default dibalik, validator jadi opsional).
- **Out of scope:** bug lama tak-terkait yang kebetulan terlihat — catat, jangan ajukan sebagai temuan PR ini.
- **Baca kode, bukan cerita commit** — judul/deskripsi bisa optimistis/menyesatkan.

Cara Mia: `exec` `git diff <base>...HEAD` → scope review/AST ke file berubah → validasi.
