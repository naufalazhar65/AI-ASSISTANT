<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: fix-and-verify
description: Ubah temuan tervalidasi jadi perbaikan minimal yang benar — triage severity, patch root cause (bukan payload), pakai defense framework, lalu buktikan fix mematikan exploit lewat re-test.
---

# Fix & Verify (Mia)

## 1. Triage

Ambil temuan dari board: `finding_list` (urut CVSS/severity). Setiap temuan tervalidasi punya PoC — **jangan** anggap false positive tanpa menguji ulang PoC-nya. Urutan kerja: critical → high → medium → low (`hardening_plan` menyusun prioritas CVSS).

## 2. Perbaiki

Untuk tiap temuan:
1. Reproduksi dengan PoC bila memungkinkan.
2. Perbaiki **root cause, bukan payload spesifik** — parameterisasi semua query (bukan blokir satu string), tegakkan otorisasi di handler (bukan sembunyikan endpoint).
3. Utamakan **defense bawaan framework** (ORM parameterization, template auto-escape, CSRF middleware, authz terpusat) di atas sanitasi ad-hoc.
4. Diff minimal, ikuti pola repo. `write_file`/`edit_file` (write → konfirmasi).

Kelas umum & fix yang diharapkan:
- **Injection** → parameterization/escaping di sink
- **IDOR/broken access control** → cek otorisasi level-objek
- **SSRF** → allowlist + blokir range internal
- **XSS** → context-aware output encoding + CSP
- **Secret bocor** → **rotate** secret DAN hapus dari kode/history
- **Auth** → perbaiki cek server-side (jangan client-side)

## 3. Verifikasi (WAJIB)

Setelah fix, buktikan temuan benar-benar hilang — bukan asumsi:
- **Re-test PoC** — ulangi request/script PoC (paling cepat & ground-truth).
- `sast_scan` ulang pada area yang diperbaiki (temuan semgrep hilang?).
- `verify_patch` untuk temuan dependency (versi terpasang >= fixed → auto-resolve).
- Jalankan test suite repo (`exec_write` `npm test`/`npm run <script>`) agar fix tak merusak perilaku.

`finding_resolve` hanya setelah verifikasi lulus. **Exit/klaim bersih** hanya berlaku untuk yang benar-benar dianalisis — scan/review yang terpotong bukan bukti aman.

## 4. Lapor

Ringkas per temuan: severity, root cause, fix diterapkan (`file:line`), hasil verifikasi (re-test bersih / PoC tak reproduksi). **Jangan** pernah menyertakan secret live di laporan; bila secret bocor, nyatakan **rotasi wajib**. Keluaran: `report_generate`/`report_pdf` (atau `finding_export` CSV/JSON/SARIF).
