<!--
Adapted from Strix (https://github.com/usestrix/strix) — Apache-2.0.
Mia tool mapping: create_vulnerability_report→finding_add, create_dependency_report→finding_add,
load_skill→security_playbook, record_coverage/agent_finish→catatan cakupan/laporan.
Knowledge pack only — not executable code.
-->
---
name: api-security-testing
description: Security-test REST/GraphQL/gRPC API memakai checklist OWASP API Security Top 10:2023 — BOLA/IDOR, property-level authz, BFLA, resource consumption, SSRF, injection, auth/token. Buktikan tiap temuan dengan request PoC.
---

# API Security Testing (Mia)

API gagal berbeda dari UI: tak ada permukaan render, bug menarik umumnya **berbentuk otorisasi** (bukan injeksi), dan endpoint yang sama berperilaku beda per token. Checklist: **OWASP API Security Top 10 (2023)**.

## 1. Kumpulkan dulu (API nyaris mustahil dites buta)

| Input | Kenapa |
|---|---|
| **Schema** — OpenAPI/Swagger, Postman, GraphQL introspection, `.proto` | Mengubah tebakan jadi enumerasi endpoint penuh. Kemenangan coverage terbesar. |
| **2 kredensial beda tenant** | BOLA/IDOR (API1:2023, risiko #1) hanya **terbukti** bila akses objek tenant A dengan token tenant B. |
| **1 low-priv + 1 high-priv token** | Untuk membuktikan BFLA (API5:2023 — user memanggil route admin). |
| **Contoh object id** | Uji ID tampering langsung. |
| **Route out-of-scope** | Payments, broadcast notifikasi, admin destruktif. |
| **Rate limit / WAF** | Supaya tak membuang kuota di request ter-throttle. |

Mia tidak boleh mengarang token/scan API yang bukan milik user. Kalau spec berupa file, minta user unggah (`list_uploads`/`read_upload`/`file_read`).

## 2. Uji API Top 10 (2023)

- **API1 BOLA / IDOR** — tukar object id lintas tenant; cek respons benar berisi data tenant lain, **bukan** 200 kosong. (`security_playbook name=idor`)
- **API3 Broken Object Property Level Authorization** — *excessive data exposure* (field sensitif ikut terkirim) + *mass assignment* (kirim field terlarang di PATCH/POST). (`name=mass_assignment`)
- **API5 BFLA** — token user memanggil route admin/privileged. (`name=broken_function_level_authorization`)
- **API4 Unrestricted Resource Consumption** — pagination/limit tak terbatas, operasi mahal berulang.
- **API6 SSRF** — parameter URL/webhook. (`name=ssrf`)
- **API7/8 Misconfig & Injection** — header, CORS, SQL/NoSQL/command via body. (`name=sql_injection`/`nosql_injection`)
- **API2/9/10 Auth & token** — JWT lemah, alg confusion, token tak kedaluwarsa. (`name=authentication_jwt`)

GraphQL: cek introspection; uji **batching/aliasing abuse**, **depth/complexity limit**, dan **authorization per-field**. (`security_playbook name=graphql`)

Alat Mia: `http_request` (method/headers/body; write/confirm, hanya target berizin) dan `lab_fetch` (GET lab). Untuk schema GraphQL, kirim query introspection via `http_request`.

## 3. Verifikasi temuan

Replay request PoC (mis. `http_request` ulang) sebelum lapor. Untuk temuan otorisasi, pastikan respons **memuat data tenant lain**, bukan 200 kosong. Tandai confidence: PoC live = `high`; trace statis = `medium/low` + sebut gap-nya.

## 4. Perbaiki & re-test

Perbaiki **cek otorisasi** (bukan endpoint tunggal), lalu re-test pada target sama untuk membuktikan exploit mati. (`security_playbook name=fix-and-verify`)
