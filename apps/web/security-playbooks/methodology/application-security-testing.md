<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: application-security-testing
description: Kerangka AppSec menyeluruh — petakan aset, pilih tes per aset, konsolidasi satu rencana prioritas, nyatakan coverage jujur. Titik masuk untuk "buat aplikasiku aman / audit seluruh stack".
---

# Application Security Testing (Mia)

Titik masuk saat target **belum** satu URL/repo ("amankan aplikasiku", "audit stack-ku", "review sebelum launch"). Tugasnya: pilih tes yang tepat **per aset**, jalankan, hasilkan **satu rencana prioritas** — bukan menjalankan semuanya sedalam mungkin.

## 1. Petakan aset (tanyakan/inspeksi dulu)

- **Source** — satu repo, monorepo, beberapa service? bahasa/framework? → `codebase_search`, `codebase_refresh`, `sast_scan`
- **Lingkungan jalan** — ada staging? produksi publik? cuma dev lokal? → `recon_*`, `web_audit`, `pentest_scan`
- **API** — REST/GraphQL/gRPC? ada OpenAPI/GraphQL schema? → `http_request`
- **Auth** — bisa dapat **2 akun beda tenant** + **1 privileged**? (BOLA/IDOR cuma bisa *dibuktikan* lintas tenant)
- **Batasan** — path out-of-scope, boleh sentuh produksi?, batas waktu.

Tanpa staging & produksi terlarang → katakan di depan. Review kode tetap berguna, tapi **tidak bisa** membuktikan exploitabilitas live.

## 2. Pilih tes per aset

| Aset | Playbook / tool |
| --- | --- |
| Repo / working tree | `security_playbook name=whitebox-code-review` + `sast_scan` |
| Web app / staging live | `recon_subdomains` → `pentest_scan`/`http_request` → `security_playbook name=owasp-top-10-testing` |
| REST/GraphQL/gRPC API | `security_playbook name=api-security-testing` |
| Assessment ter-map OWASP | `security_playbook name=owasp-top-10-testing` |
| Dependency / secret | `dep_audit` / `trivy_scan` / `secret_scan` |
| Perubahan (diff-only) | `exec` `git diff` → scope review ke subtree yang berubah |

Urutan assessment pertama: **kode dulu** (paling murah, memetakan model otorisasi) → **staging dengan kredensial** (source + live sekaligus) → baru perluasan. Jalankan satu aset per langkah, baca hasil sebelum lanjut.

## 3. Konsolidasi jadi satu rencana

Gabungkan findings, urutkan berdasar **dampak terbukti**, bukan severity scanner:

1. Exploit tervalidasi **tanpa autentikasi**.
2. Tervalidasi **lintas tenant / privilege escalation**.
3. Tervalidasi **perlu akun terautentikasi**.
4. Observasi **belum terbukti** (config/hardening/dependency note) — tandai sebagai belum terkonfirmasi, **jangan** dipresentasikan sebagai vuln.

Dedup: root cause sama sering muncul di review kode **dan** pentest live. Simpan ke board (`finding_add`) lalu `hardening_plan` → `report_generate`/`report_pdf`.

## 4. Jujur soal coverage

Sebut eksplisit apa yang **tidak** diuji: aset tanpa staging, kategori yang tak terjangkau black-box (logging/alerting, supply-chain integrity, insecure design), dan run yang berhenti karena batas waktu/round. **Hasil kosong dari scan yang terpotong bukan bukti aman.** Tandai kandidat yang tak bisa dikonfirmasi sebagai **NEEDS_FOLLOW_UP** (jangan dibuang diam-diam).

## 5. Perbaiki & verifikasi

Perbaikan → `security_playbook name=fix-and-verify`: patch root cause, lalu **re-test** untuk membuktikan exploit mati. Retest adalah satu-satunya konfirmasi fix benar-benar mendarat.
