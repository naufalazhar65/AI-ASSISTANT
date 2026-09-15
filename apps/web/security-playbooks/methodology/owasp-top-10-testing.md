<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: owasp-top-10-testing
description: Assessment sistematis terhadap OWASP Top 10:2025 (dengan tabel coverage jujur per kategori) + OWASP API Security Top 10:2023. Petakan tiap temuan ke id kategori dan laporkan edisi yang dipakai.
---

# OWASP Top 10 Testing (Mia)

OWASP Top 10 adalah **taksonomi risiko**, bukan test suite. "OWASP testing" = uji tiap kategori terhadap aplikasi nyata dan laporkan apa yang benar-benar bisa dieksploitasi.

**Pakai edisi terbaru: [OWASP Top 10:2025](https://owasp.org/Top10/).** Tanyakan bila klien/compliance masih merujuk 2021. Perbedaan kunci dari 2021: **SSRF dilebur ke A01**, **A03 Software Supply Chain Failures** memperluas "Vulnerable & Outdated Components", **A10 Mishandling of Exceptional Conditions** baru, A02 Security Misconfiguration naik 5→2.

## Apa yang testable (jujur — jangan klaim bersih 10/10)

| Kategori (2025) | Coverage | Catatan untuk Mia |
|---|---|---|
| A01 Broken Access Control (incl. SSRF) | **Kuat** | Uji lintas-user/tenant, privesc, IDOR, SSRF. Butuh **2 akun** + 1 privileged. Playbook `idor`/`ssrf`. |
| A02 Security Misconfiguration | **Kuat** | Debug endpoint, error verbose, CORS longgar, default creds, admin surface. `web_audit`, `pentest_scan`. |
| A03 Software Supply Chain Failures | **Parsial** | `dep_audit`/`trivy_scan`/`sast_scan` untuk versi rentan + source. Kompromi build/distribusi di luar runtime scan. |
| A04 Cryptographic Failures | **Parsial** | `tls_check`, secret/token bocor di respons. Crypto at-rest & key mgmt perlu review source/infra. |
| A05 Injection | **Kuat** | SQLi/NoSQL/command/template/XSS. `sqlmap_scan`, `http_request`, playbook `sql_injection`/`xss`/`ssti`/`nosql_injection`. |
| A06 Insecure Design | **Parsial** | Business-logic abuse (tamper harga/qty, skip workflow, race). Playbook `business_logic`/`race_conditions`. |
| A07 Authentication Failures | **Kuat** | Auth bypass, session/token lemah, reset password/MFA. Playbook `authentication_jwt`. |
| A08 Integrity Failures | **Parsial** | Deserialization tak aman, unsigned update. Playbook `insecure_deserialization`. |
| A09 Logging & Alerting Failures | **Tidak testable dari luar** | Perlu review pipeline logging/alerting. Nyatakan "tidak diuji", bukan "lulus". |
| A10 Mishandling of Exceptional Conditions | **Parsial** | Probing error handling/fail-open (input malformed, forced error, race/timeout) via `http_request`; jalur error internal butuh source. |

Untuk API, jalankan latihan yang sama terhadap **OWASP API Security Top 10 (2023)** — API1 BOLA, API3 Broken Object Property Level Authorization, API5 BFLA — via playbook `api-security-testing`.

## Cara Mia menguji

1. Muat playbook kelas yang relevan per kategori (`security_playbook name=<kelas>`).
2. Uji **hanya** target berizin (`targetAllowed`: lab/engagement/`PENTEST_LAB_TARGETS`).
3. Setiap kandidat → jalankan pass **counterevidence** & **severity-calibration** sebelum `finding_add`.
4. Map tiap temuan ke id kategori 2025 (field `owasp`, mis. `A01:2025 Broken Access Control`).

## Laporkan jujur

Kelompokkan temuan per kategori; nyatakan per kategori: **apa yang diuji, apa yang terbukti, apa yang tak bisa diassess** (A09 selalu; A03/A04/A06/A08/A10 parsial). **Labeli edisi** yang dipakai. Kandidat tak terkonfirmasi = **NEEDS_FOLLOW_UP**, bukan dibuang. Verifikasi tiap PoC sebelum masuk laporan.
