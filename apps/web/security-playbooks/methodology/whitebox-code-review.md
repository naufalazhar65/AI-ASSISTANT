<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: whitebox-code-review
description: White-box security review source — baca kode untuk membangun model route/sink/otorisasi, lalu validasi dinamis. Static-only = belum terkonfirmasi (confidence medium/low + sebut gap).
---

# White-Box Code Review (Mia)

Review keamanan white-box: Mia membaca source untuk membangun model **route, sink, dan cek otorisasi**, lalu berusaha membuktikan exploitabilitas. Output = daftar singkat isu **terbukti**, bukan ratusan "potential" ala scanner pola.

## Cara menjalankan (Mia)

1. Peta source: `codebase_refresh` (indeks) → `codebase_search` untuk route/authz/sink.
2. Triage statis: `sast_scan` (semgrep `p/default`+`p/secrets`) → kandidat berisiko.
3. Trace **source → control → sink → impact** untuk kandidat teratas (bukan berhenti di hit scanner).
4. Bila ada instance jalan → validasi dinamis (`pentest_scan`/`lab_fetch`/`http_request`). Ini pembeda "kelihatannya tidak aman" vs temuan tervalidasi.

Dua hal yang menajamkan hasil:
- **Tambah instance yang berjalan** — konfirmasi exploitabilitas terhadap perilaku live.
- **Scope review** — arahkan ke subtree berisiko dan sebutkan yang penting (model tenancy, trust boundary, input mana yang attacker-controlled). Mia **tidak bisa** menyimpulkan tenancy/trust boundary secara andal — user harus memberi tahu.

Untuk PR/diff: scope ke yang berubah via `exec` `git diff <base>...HEAD` lalu review subtree itu saja.

## Baca hasil

Sebelum lapor, buka tiap temuan dan cek PoC benar menunjukkan dampak. Sertakan `file:line` di samping exploit supaya fix jelas (`finding_add` + field `evidence`/`steps`).

**Static-only = belum terkonfirmasi.** Bila validasi runtime tak tercapai (tak ada kredensial/instance), temuan statis masih boleh dilaporkan di **confidence medium/low** dengan gap disebut eksplisit. Yang **tidak** boleh: hit scanner tanpa trace, klaim "pola ini biasanya bahaya", atau temuan tanpa input attacker yang jelas.

## Pelengkap (bukan pengganti)

`dep_audit`/`trivy_scan` (CVE dependency) dan `secret_scan` (kredensial ter-commit) untuk known-CVE & secret. White-box menangkap bug **logika, otorisasi, dan injeksi** yang tak bisa ditemukan scanner dependency.

## Perbaiki & verifikasi

Patch **root cause** (helper otorisasi bersama, bukan satu route), lalu `sast_scan`/re-test untuk membuktikan exploit mati. (`security_playbook name=fix-and-verify`)
