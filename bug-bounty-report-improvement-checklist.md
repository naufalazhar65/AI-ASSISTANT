# Bug Bounty Report — Audit & Improvement Checklist

## Status Saat Ini

**Kesimpulan audit:** report sudah terlihat profesional sebagai **Pentest Report**, tetapi masih perlu beberapa perbaikan sebelum dianggap **bug-bounty submission ready**.

Fokus utama:
1. Hapus/merge duplicate findings.
2. Perbaiki severity dan CVSS evidence.
3. Lengkapi PoC yang belum benar-benar membuktikan exploit.
4. Hindari overclaim.
5. Rapikan target, reference, dan terminology.
6. Redact credential/PII sensitif.
7. Pisahkan format Pentest Report dan Bug Bounty Submission.

---

# 1. PRIORITAS KRITIS — WAJIB DIPERBAIKI

## 1.1 Merge Duplicate SQL Injection

### Masalah
Report memiliki dua finding untuk endpoint/parameter yang sama:

- Critical — UNION-based SQL Injection
- High — SQL Injection via `q`

Keduanya berasal dari root cause yang sama: raw SQL interpolation pada `/api/cari-berita?q`.

### Perbaikan
Jadikan **1 finding saja**:

> **SQL Injection in `/api/cari-berita?q` allows unauthenticated database access and credential disclosure**

Gabungkan seluruh PoC ke satu finding:

- baseline request
- single quote/error behavior
- column count discovery
- `sqlite_master` enumeration
- `users` table extraction
- sensitive data impact

### Jangan
Jangan submit kedua finding ini sebagai dua bug terpisah.

---

## 1.2 Merge Duplicate IDOR `/api/cek-nik`

### Masalah
Ada beberapa finding yang overlap:

- IDOR `/api/cek-nik` exposes citizen PII + internal notes
- IDOR `/api/cek-nik` exposes NIK
- Unauthenticated personal-data exposure pada `/api/cek-nik`

Root cause dan attack path sangat mirip: unauthenticated sequential object access.

### Perbaikan
Gabungkan menjadi satu finding:

> **Unauthenticated IDOR on `/api/cek-nik` exposes citizen PII and internal data**

Tunjukkan:

```text
GET /api/cek-nik?id=1
GET /api/cek-nik?id=2
GET /api/cek-nik?id=3
```

Lalu buktikan bahwa data record berbeda dapat diakses tanpa authentication/authorization.

---

## 1.3 Merge Duplicate Security Headers

### Masalah
Ada dua finding:

- Medium — Missing HTTP security headers
- Low — Missing security headers

Keduanya membahas header yang sama.

### Perbaikan
Gabungkan menjadi satu finding.

Contoh:

> **Missing security headers on the web application**

Kemudian pilih satu severity yang sesuai dengan program dan impact yang benar-benar terbukti.

---

# 2. PRIORITAS TINGGI — VALIDASI TECHNICAL EVIDENCE

## 2.1 Stored XSS Belum Sepenuhnya Terbukti

### Yang sudah terbukti
Payload:

```html
<script>alert(document.domain)</script>
```

berhasil:

1. dikirim ke `/api/pengaduan`
2. disimpan
3. dikembalikan kembali oleh API

### Yang belum terbukti
Report masih menggunakan asumsi:

> Jika complaints page merender field tanpa escaping, script akan execute.

Artinya storage + raw reflection sudah terbukti, tetapi **actual JavaScript execution di browser belum dibuktikan**.

### Perbaikan wajib
Buktikan:

```text
1. POST malicious payload
2. Login/access sebagai staff/admin
3. Buka complaints page
4. Payload dirender
5. JavaScript benar-benar execute
6. Simpan screenshot/video sebagai evidence
```

### Jika tidak execute
Jangan label sebagai Stored XSS. Deskripsikan sesuai behavior yang benar-benar terbukti.

---

## 2.2 Buktikan Admin Takeover Secara End-to-End

Finding `/api/admin-data` sudah menunjukkan credential disclosure.

Agar impact lebih kuat, tunjukkan:

```text
GET /api/admin-data
        ↓
admin credential exposed
        ↓
POST /login
        ↓
admin session created
        ↓
admin-only endpoint/page accessible
```

Tidak perlu melakukan destructive action.

Cukup buktikan bahwa leaked credential dapat menghasilkan akses administratif.

### Gunakan redaction
Jangan memasukkan password asli secara penuh di report final.

Contoh:

```text
username: admin
password: <REDACTED>
role: admin
```

---

## 2.3 Jangan Klaim "Entire Database" Tanpa Evidence

### Masalah
Report menyatakan:

> attacker can read the ENTIRE database

Padahal evidence yang terlihat secara eksplisit membuktikan:

- schema enumeration
- `users` table extraction

### Perbaikan
Gunakan wording yang lebih defensible:

> The SQL injection allows unauthenticated SQL-based data extraction. The PoC demonstrates schema enumeration and extraction of plaintext credentials from the `users` table.

Jika tabel lain memang sudah berhasil diekstrak, tambahkan PoC-nya.

### Pisahkan
**Demonstrated impact**
- data yang benar-benar berhasil diambil

**Potential impact**
- dampak tambahan yang belum diverifikasi

---

# 3. PRIORITAS TINGGI — PERBAIKI SEVERITY & CVSS

## 3.1 Sertakan CVSS Vector

Saat ini beberapa finding hanya menampilkan:

```text
CVSS 8.2
CVSS 8.1
CVSS 7.5
```

### Perbaikan
Sertakan:

```text
CVSS v3.1: X.X
Vector: CVSS:3.1/...
```

Dengan begitu reviewer dapat melihat dasar scoring.

---

## 3.2 Jangan Campur Label Platform Seolah-olah Final

Saat ini ada format seperti:

```text
PLATFORM HackerOne "critical"
Bugcrowd VRT P1
```

### Perbaikan
Gunakan:

```text
Suggested Severity: Critical
CVSS v3.1: 9.8
CWE-89
OWASP A05:2025 Injection
```

Jika VRT diperlukan:

```text
Bugcrowd VRT: P1 baseline
```

Jangan menyiratkan bahwa severity tersebut pasti merupakan final platform rating.

---

## 3.3 Verifikasi Severity IDOR

Read-only IDOR dan modification IDOR dapat memiliki severity berbeda.

Untuk setiap IDOR, dokumentasikan:

- apakah hanya READ?
- apakah MODIFY juga mungkin?
- apakah identifier sequential?
- apakah data sensitif?
- apakah authentication benar-benar tidak diperlukan?
- berapa banyak object yang dapat dienumerasi?

Jangan menaikkan severity hanya karena datanya sensitif tanpa mendukungnya dengan impact dan scoring.

---

# 4. PRIORITAS TINGGI — PERBAIKI KONSISTENSI REPORT

## 4.1 Perbaiki Target `/api/profil-pegawai`

### Masalah
Finding:

> IDOR on `/api/profil-pegawai`

tetapi target tertulis `/cek-nik`.

### Seharusnya
```text
GET /api/profil-pegawai?id=1
```

Pastikan:

- title
- target
- endpoint
- request
- evidence

semuanya menunjuk endpoint yang sama.

---

## 4.2 Tambahkan Expected vs Actual Behavior

Gunakan format konsisten untuk setiap finding.

### Expected Behavior

```text
Unauthenticated users should receive 401/403
and no sensitive record should be returned.
```

### Actual Behavior

```text
The endpoint returns HTTP 200 and exposes
the requested record without authentication.
```

Ini membuat triager lebih cepat memahami masalah.

---

## 4.3 Hapus `Threat model = NONE`

Bagian:

```text
NONE Threat model
```

terlihat seperti artifact dari report generator.

### Perbaikan
Jika threat model memang dibutuhkan, isi dengan threat model nyata.

Kalau tidak dibutuhkan:

**hapus section tersebut.**

---

# 5. PRIORITAS TINGGI — REDACTION & DATA HANDLING

## 5.1 Jangan Tampilkan Password Asli

Current report menampilkan plaintext password.

### Ganti menjadi

```json
{
  "username": "admin",
  "password": "<REDACTED>",
  "role": "admin"
}
```

Lalu jelaskan bahwa password digunakan hanya untuk validasi akses dan telah di-redact dari report.

---

## 5.2 Redact NIK dan PII

Untuk:

- NIK
- alamat
- tanggal lahir
- email personal
- credential
- token
- session identifiers

gunakan:

```text
<REDACTED>
```

atau partial masking:

```text
357101********0001
```

Gunakan data minimum yang diperlukan untuk membuktikan vulnerability.

---

# 6. PRIORITAS MEDIUM — REMEDIATION

## 6.1 SQL Injection

Remediation utama:

```text
- Use parameterized queries / prepared statements
- Never concatenate user input into SQL
- Validate input and enforce reasonable length limits
- Apply least-privilege database permissions
- Rotate any exposed credentials
- Store passwords using Argon2id/bcrypt
```

WAF boleh disebut sebagai **defense in depth**, bukan pengganti parameterized query.

---

## 6.2 Broken Access Control

Gunakan:

```text
- Server-side authentication
- Server-side authorization
- Derive role from validated session
- Ignore client-supplied role headers
- Enforce object-level authorization
- Audit access attempts
```

Jangan mengandalkan:

```text
localStorage role
x-user-role
client-side flags
```

sebagai security boundary.

---

## 6.3 IDOR / Personal Data Exposure

Remediation:

```text
- Require authentication
- Perform object-level authorization
- Return only required fields
- Remove internal fields from public responses
- Add rate limiting
- Add access logging
- Avoid sequential identifiers where useful as defense in depth
```

Catatan:

> UUID/non-sequential ID bukan pengganti authorization.

---

## 6.4 Stored XSS

Gunakan:

```text
- Context-aware output encoding
- Auto-escaping templates
- Input validation
- Strict CSP as defense in depth
```

Jangan menjadikan sanitization saja sebagai satu-satunya control.

---

## 6.5 Security Headers

Header yang relevan dapat mencakup:

```text
Content-Security-Policy
X-Frame-Options
X-Content-Type-Options
Referrer-Policy
Strict-Transport-Security
Permissions-Policy
```

Severity jangan dinaikkan hanya karena header hilang; kaitkan dengan exploitability dan demonstrated impact.

---

# 7. PRIORITAS MEDIUM — REFERENCES & TAXONOMY

## 7.1 Gunakan OWASP Taxonomy secara konsisten

Report saat ini mencampur:

```text
OWASP Top 10:2025
OWASP Top 10:2021
```

### Perbaikan
Pilih taxonomy yang sesuai kebutuhan report.

Misalnya:

```text
OWASP Top 10:2025
CWE-89
```

Untuk API-specific finding bisa tambahkan taxonomy API yang relevan.

---

## 7.2 References Harus Relevan

Jangan menambahkan reference hanya untuk terlihat lengkap.

Setiap reference sebaiknya mendukung:

- vulnerability classification
- remediation
- security standard
- scoring

---

# 8. STRUKTUR BUG BOUNTY SUBMISSION YANG DISARANKAN

Gunakan format pendek berikut untuk **setiap vulnerability**:

```markdown
# Title

## Summary

## Affected Asset

## Endpoint

## Vulnerability Type

## Severity

## CVSS v3.1
CVSS:3.1/...

## Prerequisites

## Steps to Reproduce

1. ...
2. ...
3. ...

## Expected Behavior

...

## Actual Behavior

...

## Impact

...

## Evidence

Request:
...

Response:
...

Screenshot/Video:
...

## Root Cause

...

## Remediation

...

## References

...
```

---

# 9. FINDING YANG SEBAIKNYA DIPERTAHANKAN

Setelah consolidation, struktur findings dapat menjadi seperti:

### 1. SQL Injection
```text
/api/cari-berita?q
```

Gabungkan:
- Critical UNION SQLi
- High SQLi error-based

---

### 2. Unauthenticated Admin Data Exposure
```text
/api/admin-data
```

Impact:
- plaintext credentials
- employee PII
- possible admin authentication

---

### 3. IDOR / Unauthenticated Citizen Data Exposure
```text
/api/cek-nik?id=
```

Impact:
- NIK
- name
- DOB
- address
- other personal data
- internal notes

---

### 4. IDOR / Unauthenticated Employee Data Exposure
```text
/api/profil-pegawai?id=
```

Pastikan endpoint target sudah benar.

---

### 5. Authorization Bypass via `x-user-role`
```text
/api/dokumen?id=
```

Impact:
- internal/confidential documents

---

### 6. Stored XSS
```text
/api/pengaduan
```

**Keep only after actual JavaScript execution is demonstrated.**

---

### 7. Missing Security Headers

Gabungkan duplicate:

- Medium security headers
- Low security headers

Severity ditentukan berdasarkan context/impact dan requirement program.

---

# 10. JANGAN LUPA: BEDA REPORT PENTEST VS BUG BOUNTY

## Pentest Report

Cocok untuk PDF saat ini:

```text
Executive Summary
Risk Overview
Finding Index
CVSS Summary
Detailed Findings
Remediation
Evidence
```

## Bug Bounty Submission

Lebih efektif:

```text
1 vulnerability
1 root cause
1 clear PoC
1 clear impact
1 clear remediation
```

Jangan mengirim seluruh PDF sebagai pengganti submission detail bila platform meminta report per vulnerability.

---

# 11. FINAL PRE-SUBMISSION CHECKLIST

Sebelum submit, cek semua:

- [ ] Tidak ada duplicate finding.
- [ ] Satu root cause = satu finding, kecuali instance memang berbeda dan justified.
- [ ] Semua endpoint/URL benar.
- [ ] Semua PoC dapat direproduksi.
- [ ] XSS benar-benar execute, bukan hanya tersimpan.
- [ ] Admin takeover dibuktikan end-to-end bila diklaim.
- [ ] Tidak ada overclaim seperti "entire database" tanpa evidence.
- [ ] Demonstrated impact dipisahkan dari potential impact.
- [ ] Setiap severity memiliki alasan yang jelas.
- [ ] CVSS vector dicantumkan.
- [ ] CWE/OWASP taxonomy konsisten.
- [ ] Expected Behavior ada.
- [ ] Actual Behavior ada.
- [ ] Request/response evidence jelas.
- [ ] Password/token/NIK/PII sudah di-redact.
- [ ] `Threat model = NONE` dihapus.
- [ ] References relevan.
- [ ] Remediation actionable.
- [ ] Tidak ada typo endpoint.
- [ ] Report tidak melakukan destructive testing.
- [ ] Submission sesuai scope dan rules program.

---

# 12. PRIORITAS PERBAIKAN PALING CEPAT

Urutan yang disarankan:

```text
1. Merge duplicate findings
2. Fix wrong endpoint/target
3. Remove "Threat model = NONE"
4. Redact passwords + PII
5. Fix SQLi overclaim
6. Add CVSS vectors
7. Verify IDOR severity
8. Prove actual Stored XSS execution
9. Prove admin access end-to-end
10. Standardize Expected vs Actual
11. Standardize OWASP/CWE references
12. Create individual bug-bounty submissions
```

---

# Final Assessment

### Pentest Report
**Status: GOOD DRAFT**

### Bug Bounty Submission
**Status: NEEDS REVISION**

### Biggest risks before submission

```text
HIGH  — Duplicate/overlapping findings
HIGH  — Stored XSS not yet proven to execute
HIGH  — Some impact claims are stronger than the shown evidence
HIGH  — Credential/PII exposed in report
MED   — CVSS vectors missing
MED   — Inconsistent taxonomy/references
MED   — Endpoint typo
LOW   — Report generator artifact ("Threat model = NONE")
```

### Target akhir

Report yang ideal harus:

> **concise + reproducible + evidence-based + technically precise + minimal duplication**

Jangan menambah klaim untuk membuat severity terlihat lebih tinggi. Untuk bug bounty, **bukti yang kuat biasanya jauh lebih bernilai daripada wording yang bombastis.**
