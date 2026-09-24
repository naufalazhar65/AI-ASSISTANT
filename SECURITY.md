# 🔐 Mia — Cybersecurity / Ethical-Hacker Toolkit

Mia can act as a **defensive / authorized** security assistant: audit your own
machine & code, run permitted scans, track findings, and produce client-ready
reports. Everything here is **keyless** by default and runs on the owner's Mac.

> **Scope & ethics (hard rule).** Only test systems you own or have **written
> authorization** for. Active scans are limited to `localhost`, RFC1918/private
> hosts, an **active Engagement** scope, `PENTEST_LAB_TARGETS`, or the two
> explicitly scan-permitted public hosts. **Bug bounty** programs
> (HackerOne/Bugcrowd/YesWeHack/Intigriti) authorize their **in-scope** assets
> under safe harbour — register those hosts via `engagement_create`
> (authorization = the program policy URL, `scope` = in-scope assets) and follow
> the program's RoE: in-scope hosts only, **manual + rate-limited by default**
> (automated scanners only if the RoE allows), no DoS/stress, no other users'
> data, no social engineering when banned. Public third-party demos (e.g.
> `itsecgames.com`/bWAPP online, TryHackMe, Hack The Box, PortSwigger) are **not**
> targets — use them as learning material only. Mia cannot verify legality; the
> Engagement record (client/program + authorization reference) is your audit trail.

---

## 1. Quick start

```bash
# Repo root. Security tools need no extra key.
npm run typecheck && npm test && npx tsx apps/web/verify.ts   # gates

# Optional CLI tools (light):
brew install nmap nikto ffuf sqlmap          # + nuclei (usually already)
# Heavy & optional (containers lab): Docker — see labs/pentest/README.md
```

Then just talk to Mia (Web / Telegram / Discord). Read-only tools run
immediately; write tools (scans, edits) ask **`ya`** first (FR-014).

---

## 2. Tool catalog

### 2.1 Posture & hygiene (read, auto)
| Tool | What | Example |
|---|---|---|
| `security_scan` | macOS posture (FileVault/Firewall/Gatekeeper/SIP/listening ports) + score | `cek keamanan mac-ku` |
| `secret_scan` | find leaked secrets in a sandbox dir (AWS/GCP/Slack/OpenAI/GitHub tokens, keys, JWT, generic) — **values redacted** | `cek ada api key bocor ga di repo` |
| `breach_check` | password breach via HIBP Pwned Passwords (**k-anonymity**, keyless; args redacted in audit) | `password "rahasia123" bocor ga?` |
| `tls_check` | cert issuer/expiry/chain for a host | `cek sertifikat domainku.com` |

### 2.2 Passive recon (read, auto)
| Tool | What |
|---|---|
| `exec dig / nslookup / host / whois` | DNS + registration lookups |
| `web_audit` | one GET → security headers present/missing, cookie flags, server banner, score (**public http(s) only**; redirects followed manually with per-hop SSRF validation) |
| `domain_audit` | SPF, DMARC(+policy), DKIM (common selectors), CAA, MX, NS |
| `exec tcpdump -r / nc -z / searchsploit` | read a pcap (`-r`; capture needs sudo), port check (`nc -zv host port`), Exploit-DB lookup |

### 2.3 Recon / attack surface (keyless)
| Tool | What | Scope |
|---|---|---|
| `recon_subdomains` | passive subdomain enum via Certificate Transparency (crt.sh, hackertarget fallback) | any domain (public OSINT) |
| `recon_params` | passive URL + query-param mining from public archives (OTX + urlscan + Wayback); flags interesting params (`id`/`redirect`/`url`/`file`/…) | any domain (public OSINT) |
| `recon_httpx` | **active** live-host probe (status/server/title) over cached subdomains or a given host list | lab / engagement / `PENTEST_LAB_TARGETS` only (write → confirm) |
| `recon_takeover` | passive subdomain-takeover candidates — resolves CNAMEs and matches known claimable services (GitHub Pages/Heroku/S3/Azure/Netlify/Vercel/…) | any domain (DNS-only OSINT) |
| `recon_list` | per-user recon cache summary (subdomains / live / params / takeover) | read, auto |

Results are cached per user at `.data/users/<user>/recon.json` so
`recon_subdomains → recon_httpx` can run in sequence. Flow: `recon_subdomains`
→ `recon_httpx` → `recon_params` → manual test (authorized URLs) → `finding_add`.

### 2.4 Active scanning (write → confirm; scope-enforced)
| Tool | Tools used | Scope |
|---|---|---|
| `pentest_scan` | `nmap`, `nuclei` (`-as`), `nikto`, `ffuf`/`gobuster` (built-in wordlist), `whatweb` | lab/engagement/permitted only |
| `http_request` | raw HTTP (method/headers/body) for API testing (REST/GraphQL/mass-assignment) | lab/engagement only |
| `sqlmap_scan` | `sqlmap` (SQLi) | lab/engagement only |
| `zap_scan` | OWASP ZAP baseline (Docker) | lab/engagement only |

Targets outside scope are **rejected** (`isLabTarget` / engagement scope).

### 2.5 Analysis (read, auto)
| Tool | What |
|---|---|
| `password_strength` | local entropy + common-pattern check (args redacted) |
| `hash_identify` | detect hash type + compute sha256/sha1/md5 |
| `jwt_inspect` | decode JWT + flag `alg=none` / expired |
| `ioc_extract` | IP/domain/URL/email/hash from text (handles `hxxp`/`[.]` defang) |
| `cvss_score` | CVSS v3.1 base score from a vector (e.g. `…/C:H/I:H/A:H` → 9.8) |
| `encoding` | base64 / url / hex / html / rot13 encode–decode |

### 2.6 Dependencies (read, auto)
| Tool | What |
|---|---|
| `dep_audit` | CVE audit via **OSV** (npm `package-lock.json` + PyPI `requirements.txt`); shows **nearest fixed version**; `to_findings=true` adds to board |
| `verify_patch` | compare installed versions vs each dep finding's fixed version → patched / still / unverified; `apply=true` auto-resolves patched |
| `trivy_scan` | filesystem/image CVE scan (keyless; `brew install trivy`) |
| `sast_scan` | static analysis of a sandbox source dir via **semgrep** (`p/default` + `p/secrets`) — vulnerability patterns + hardcoded secrets; `brew install semgrep` (rules download needs net on first run) |

### 2.7 Findings & reporting (read, auto)
| Tool | What |
|---|---|
| `finding_add` | record a finding (Title/Severity/**CVSS**/OWASP/CWE/Target/Steps-to-Reproduce/Evidence/Impact/Root-Cause/Remediation/References) |
| `finding_list` | open findings sorted by CVSS |
| `finding_resolve` | mark a finding resolved (drops from lists/plan/report) |
| `finding_export` | open findings → **CSV / JSON / SARIF 2.1.0** under `.data/users/<user>/reports/` |
| `hardening_plan` | CVSS-prioritized remediation plan |
| `report_generate` | markdown pentest report (incl. active Engagement header) |
| `report_save` / `report_pdf` / `hardening_pdf` | write MD / render PDF (via Playwright) |

### 2.8 Lab lifecycle
| Tool | What |
|---|---|
| `lab_status` / `lab_start` / `lab_fetch` | start/stop/status the local lab; `lab_fetch` GETs a **lab/authorized** URL (bypasses the public SSRF guard for your own lab) |

### 2.9 Engagement & Scope (client authorization)
| Tool | What |
|---|---|
| `engagement_create` | record `name`, `client`, `authorization` (PO/contract/email), `scope[]`, `out_of_scope[]`, `window_start/end`, `contact`, `notes` (**write → asks `ya` first**: this record is what grants scan permission) |
| `engagement_list` / `engagement_close` | manage engagements |
| `pentest_resources` | practice platforms + local lab URLs + scope reminder |

Once an engagement is **ACTIVE**, hosts in its `scope` become scannable by
`pentest_scan` / `sqlmap_scan` / `zap_scan` / `lab_fetch`; out-of-scope is
refused.

---

### 2.10 Playbooks & methodology (read, auto)
| Tool | What |
|---|---|
| `security_playbook` | loads a pentest knowledge pack on demand (`name=` or `query=`, no args = catalog) |

**85 packs across 11 categories** live in
`apps/web/security-playbooks/<category>/<name>.md`, **adapted from
[Strix](https://github.com/usestrix/strix) (Apache-2.0)**:

- `methodology` — application-security-testing (AppSec end-to-end), owasp-top-10-testing (**OWASP Top 10:2025**), api-security-testing (**API Top 10:2023**), whitebox-code-review, fix-and-verify, source-aware-whitebox, browser-transport-tampering (tamper via app transport when a WAF blocks programmatic replay), authenticated-testing (CDP to the user's own browser — real session, secrets never reach the LLM), reading-prover-results (**cara membaca output prover — verdict classes, baseline, hukum naik-kelas; anti "a fool with a tool is still a fool"**)
- `scan_modes` — scan-modes (quick / standard / deep / diff)
- `analysis` — counterevidence, severity-calibration, fix-verification, source-aware-discovery
- `vulnerabilities` (×34) — ssrf, idor, xss, sql_injection, ssti, xxe, csrf, race_conditions, http_request_smuggling, authentication_jwt, mass_assignment, path_traversal, nosql_injection, insecure_deserialization, prototype_pollution, business_logic, subdomain-takeover, llm-prompt-injection, web-cache-poisoning (Mia), websocket-security (Mia), account-takeover (Mia), host-header-injection (Mia), authorization-matrix (Mia), teamcity-cve-2026-63077 (Mia), …
- `tooling` — nmap, nuclei, httpx, ffuf, sqlmap, subfinder, katana, naabu, semgrep, hurl, python, agent_browser, hypothesis
- `protocols` — oauth, graphql
- `frameworks` — nextjs, django, fastapi, nestjs
- `technologies` — llm-applications, active_directory, auth0, firebase, supabase, grafana_prometheus, electron_desktop_apps
- `cloud` — aws, azure, gcp, kubernetes
- `reconnaissance` — asset_discovery, infrastructure-lifecycle
- `custom` — source-aware-sast, dependency_cve_scanning, api_spec_testing, npx_confusion

The agent is instructed to **load the relevant pack before testing**, and to run
the counterevidence → severity-calibration → fix-verification passes before
recording a finding. Add a pack by dropping a `.md` with `name:`/`description:`
frontmatter into the matching category folder.

---

### 2.11 Bug-bounty toolkit
| Tool | What | Risk |
|---|---|---|
| `oast_create` / `oast_poll` / `oast_stop` | out-of-band callback (webhook.site, keyless) — **confirms blind** SSRF / blind-XSS / XXE / RCE by a real callback hit | read, auto |
| `http_session` | named cookie/header sessions (`set`/`list`/`delete`) for authenticated & multi-identity testing | read, auto |
| `http_request` | now takes `session` (apply stored cookies/headers) and `save_session` (capture Set-Cookie after login) | write → confirm |
| `bola_diff` | same request with two sessions (A/B) → flags IDOR/BOLA (identical 200 to both identities) | write → confirm |
| `content_discover` | robots.txt/sitemap, page links, JS endpoint mining, bounded common-path probe (`/admin`, `/.env`, `/swagger.json`, …) | write → confirm |
| `param_fuzz` | inject a small XSS/SQLi/SSTI/redirect/cmdi payload set into each param, flags reflection/SQL-error/SSTI-eval/redirect/timing (optional `callback` adds SSRF) | write → confirm |
| `jwt_attack` | decode / forge `alg:none` · HS256 · alg-confusion / crack weak HS256 secret (local crypto; test the token via `http_request`) | read, auto |
| `evidence_capture` | save raw HTTP request/response and/or a full-page screenshot to `reports/evidence/` for the report | write → confirm |
| `scope_import` | parse a program's Targets (pasted `text` or public `url`) into in-scope/out-of-scope + a ready `engagement_create` suggestion | read, auto |
| `recon_diff` | diff cached subdomains vs now → flag **new**/gone assets (passive CT) | read, auto |
| `recon_screenshot` | visual recon — screenshot cached live hosts (≤12) to `reports/evidence/` | write → confirm |
| `crawl` | bounded same-origin BFS crawl — pages, paths, forms+fields, JS files (≤60 pages, depth ≤3) | write → confirm |
| `param_discover` | probe ~100 common param names for hidden parameters (response change/reflection) | write → confirm |
| `js_mine` | mine JS bundles for endpoints + secret/token indicators (values redacted) | write → confirm |
| `api_spec` | enumerate endpoints from an OpenAPI/Swagger or Postman JSON spec (`path`/`url`/`text`) | read, auto |
| `graphql_probe` | GraphQL introspection → query/mutation fields; flags when introspection is disabled | write → confirm |
| `request_save` / `request_run` | save request templates with `{{variables}}` and replay them (scope-gated) | read / write → confirm |
| `platform_severity` | map CVSS/severity → HackerOne severity + Bugcrowd VRT priority (also added to the report) | read, auto |
| `recon_dnsbrute` | passive DNS wordlist (~120 common names) + wildcard check | read, auto |
| `recon_ports` | common TCP ports (native connect) on an in-scope host | write → confirm |
| `bucket_enum` | S3/GCS bucket candidates from the domain name (public-list detection) | write → confirm |
| `cve_intel` | CVE/exploit intel — NVD keyword search + searchsploit if installed | read, auto |
| `submission_track` | track submitted reports + status (dedup hint) | read, auto |
| `cors_audit` | CORS misconfiguration test (arbitrary Origin reflection, wildcard+credentials, null) | write → confirm |
| `csp_audit` | passive CSP analysis (unsafe-inline/eval, wildcard, data:, missing object-src/frame-ancestors) | read, auto |
| `http_history` | Burp-like log of active requests (http_request/bola_diff/cors) | read, auto |
| `security_hunt` | **one-shot autonomous hunt** on an in-scope host: header/cookie + CSP + CORS + content discovery + crawl + JS mining (+ param discovery with `deep`) → ranked LEADS | write → confirm |
| `race` | send N identical requests concurrently → double-spend / TOCTOU / missing idempotency (count ≤30, not a DoS) | write → confirm |
| `ws_probe` | WebSocket handshake + first frames (optional message) | write → confirm |
| `oast_dns_create` / `oast_dns_poll` / `oast_dns_stop` | **DNS** out-of-band callback (interactsh-client) — confirms blind SQLi / XXE-OOB / SSRF-DNS / log4j | read, auto |
| `rapyd_request` | Rapyd **sandbox** API client — computes the HMAC request signature automatically (access_key/secret_key sandbox); refuses non-sandbox hosts (RoE); args redacted in the audit log | write → confirm |

Flow: `recon_*` → `content_discover` → `http_session` A/B → `http_request`/`bola_diff` → `oast_create` → send payload → `oast_poll` → `finding_add` → `report_*`. Default **manual + rate-limited**; automated scanners only if the program RoE allows.

---

## 3. Local practice lab (no Docker)

`labs/pentest/vuln-node/server.js` — an intentionally-vulnerable app
(`node:sqlite`, zero deps), bound to `127.0.0.1:4010`.

```bash
node labs/pentest/vuln-node/server.js      # or: ask Mia → lab_start
pkill -f vuln-node                         # stop
```

| Class | Endpoint |
|---|---|
| SQL injection | `/user?id=1` · `/product?id=1` · `/search?q=kopi` |
| Reflected XSS | `/greet?name=World` |
| Stored XSS | `POST /comments` (`text=<html>`) → `GET /comments` |
| IDOR | `/account?id=1` (ids 1..3, no auth) |
| Open redirect | `/redirect?to=https://example.com` |
| Path traversal (LFI) | `/file?name=public.txt` (try `../secret.txt`) |
| SSRF | `/ssrf?url=http://127.0.0.1:4010/` |
| JWT (alg=none) | `/login?user=admin` → `/admin?token=…` |
| CSRF | `POST /transfer` (`amount=1&to=bob`) → `GET /balance` |
| Broken access control | `/panel` (+ `?role=admin` or `Cookie: role=admin`) |
| Default credentials | `/admin-login?u=admin&p=admin` |
| Exposed backup | `/backup/db.sql` (listing `/backup/`) |
| Command injection | `/ping?host=127.0.0.1` (only with `VULN_ALLOW_CMDI=1`) |

Docker lab (Juice Shop/DVWA/WebGoat/bWAPP) lives in
`labs/pentest/docker-compose.yml` (optional; needs Docker).

---

## 4. Example workflows

### 4.1 Own repo
```
audit dependency repo                     → dep_audit
cek patch dependency                      → verify_patch
bikin hardening plan + PDF                 → hardening_plan / hardening_pdf
export temuan ke sarif                     → finding_export
```

### 4.2 Local lab
```
nyalain lab pentest                        → lab_start
sqlmap ke http://127.0.0.1:4010/user?id=1  → sqlmap_scan
cek XSS di http://127.0.0.1:4010/greet?name=<script>alert(1)</script>
                                           → lab_fetch / pentest_scan
catat temuan XSS …                          → finding_add
bikin laporan pentest → PDF                → report_generate / report_pdf
```

### 4.3 Authorized client engagement
```
engagement_create name="QA Web PT X" client="PT X" authorization="PO-2026-123"
                  scope=["app.ptx.co.id"] window_start="2026-09-15" window_end="2026-09-20"
pentest_scan tool=nmap target=app.ptx.co.id          # allowed (in scope)
lab_fetch url=https://app.ptx.co.id                  # allowed
finding_add title=… cvss=8.1 owasp="A01:2021" cwe="CWE-284" remediation=…
report_generate → report_pdf                         # header includes client + PO + scope
engagement_close id=ENG-…
```

---

## 5. Safety model

- **Scope guard** on every active tool (`isLabTarget` + active Engagement +
  `PENTEST_LAB_TARGETS` + 2 permitted public hosts). Scope matches the exact
  host or a SUBDOMAIN only — a parent domain is never authorized. Cloud
  metadata endpoints (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`)
  are always refused.
- **SSRF guard** shared by every URL-fetching tool (`netGuard.assertPublicUrl`):
  public http(s) only; loopback/private/link-local/ULA/`.local`/`.internal` are
  blocked, redirects validated per hop.
- **FR-014 confirmation** for scans/edits and for `engagement_create` (granting
  scan permission); read-only tools auto-run.
- **Audit log** records each tool call (`breach_check`/`password_strength` args
  redacted).
- **Secrets never echoed**: `secret_scan` reports `file:line:type` only.
- **No exploit framework** (Metasploit) and **no third-party offensive** use.

---

## 6. Prerequisites & env

| Need | Command / env |
|---|---|
| nmap/nikto/ffuf/sqlmap | `brew install nmap nikto ffuf sqlmap` |
| nuclei | installed (`nuclei -as` mode used) |
| trivy / whatweb / gobuster | `brew install trivy gobuster` · `gem install whatweb` |
| Docker lab / ZAP | `brew install --cask docker` (heavy) — optional |
| Scan extra own hosts | `PENTEST_LAB_TARGETS=host1,host2` (own/authorized) |
| Watch certs (heartbeat) | `SECURITY_CERT_DOMAINS=example.com` · `SECURITY_CERT_DAYS=14` |
| Watch new assets | `SECURITY_SCOPE_WATCH=example.com,app.example.com` (heartbeat pushes new subdomains) |
| Politeness delay | `SECURITY_REQUEST_DELAY_MS=200` (jitter between active requests) |
| Cmd-injection lab endpoint | `VULN_ALLOW_CMDI=1` |

---

## 7. Troubleshooting

- **`nuclei` hangs / no reply** → fixed: `spawn` with stdin `/dev/null` + `-as`
  (bounded ~5s).
- **`fetch_url`/`browser_*` refuse localhost** → use `lab_fetch` (lab-only GET).
- **"target publik DITOLAK"** → it's out of scope; run the target locally or
  create an Engagement with written authorization.
- **"Terjadi kendala"** → a transient provider blip; the LLM fetch auto-retries
  once and `report_generate` is delivered verbatim.
- **Duplicate dependency findings** → fixed (dedup by target+advisory).

---

## 8. Superpower Suite (2026-09-20)

Lima modul pentest canggih yang terintegrasi ke `bounty_run` untuk alur one-command penuh.

### 8.1 `target_brain` — Persistent Target Brain
| Tool | What |
|---|---|
| `target_brain` (read/auto) | Per-target KB: endpoints/params, tech fingerprint, auth model, **TERBUKTI** findings, `safeTested` (request aman), catatan. Action: `brief` (WAJIB sebelum hunt ulang), `list`, `forget`, `note`. Store: `.data/users/<user>/target-brain.json` (atomic, cap 40×120). Auto-write: `content_discover`/`js_mine`→endpoints, `tech_watch`→tech, `finding_add`→proof. |

### 8.2 `retest` — Regression Retest Suite
| Tool | What |
|---|---|
| `retest_list` (read) | Daftar case (filter `target` host). |
| `retest_add` (write, confirm) | Simpan case manual: request + signature vulnerable (`expect_contains`/`expect_status`). |
| `retest_run` (write, confirm) | Jalankan case by `id` atau per `target` → verdict 🔴 MASIH RENTAN / 🟢 sudah dipatch / ⚪ error. Scope-gated per case URL. Auto-create dari `finding_add` dg `retest_url`+`retest_expect`. |

### 8.3 `auth_matrix` — Role/Permission Matrix (N-role)
| Tool | What |
|---|---|
| `auth_matrix` (write, confirm) | `endpoints=<list> sessions=<admin,user,guest>` (+ anonymous otomatis) → 6×6 request. Output: matriks status/len + temuan `anonymous-access` & `cross-role` (±5% len). Fail-fast missing session; scope-gated per URL. |

### 8.4 `dom_taint` — DOM XSS Taint Analysis (statik)
| Tool | What |
|---|---|
| `dom_taint` (write, confirm) | Trace SOURCE (`location.*`, `postMessage`, `referrer`) → SINK (`innerHTML`, `eval`, `Function`, `document.write`, `insertAdjacentHTML`, jQuery `.html()`, `setAttribute on*`) di bundle JS. Sanitizer check (window ≤15 baris). Input: `url` (scope-gated) atau `text` (bundle dari `js_mine`). Output: `file:line sink ← source via var` + snippet. **Statik — WAJIB verifikasi manual sebelum finding_add**. |

### 8.5 `learning` — Disclosed Report Patterns
| Tool | What |
|---|---|
| `learning_ingest` (read/auto) | `text`/`url` + `title` → pattern (`vulnClass` 18 kelas, `tech`, `endpointStyle`, `trick`, `detection`) → store `.data/users/<user>/learnings-security.json` (cap 200, dedup class+title). |
| `learning_query` (read/auto) | `query=<tech> vuln_class=<kelas>` → hint "target seperti ini biasanya kena X via Y" SEBELUM hunt (score = overlap token + boost class match). Tanpa arg = statistik per kelas. |

---

### Integrasi ke `bounty_run`

`bounty_run auto_chain=true auto_evidence=true max_chains=5`:

1. `engagement_create` → `program_score` → worklist ROI
2. `campaign_run` → `suite_hunt` per host (`deep=true` default)
3. **Auto exploit_chain** per lead high-signal (heuristic: IDOR→bola_diff, auth_bypass→JWT alg:none, SSRF→OAST, session_fixation)
4. **Auto browser evidence** (snapshot)
5. `poc_verify` → `finding_add` (draft, high/medium only, +dup_check)
6. `generateReport` + **`reportPdf` otomatis** (scoped ke target) → `📎 <path>`
7. Handoff list → push ke channel

**Gates:** typecheck ✅ · lint 0 error · vitest 104/104 ✅ · verify.ts `superpowers OK` `exploit-chain OK` ✅

**Live test (Discord, Netlify Lab):** 7 findings (2 Critical: SQLi + no-auth admin-data; 3 High: BOLA, header spoof, IDOR PII; 2 Medium: Stored XSS, missing headers) + **PDF scoped ke target** (`report-2026-09-19T17-19-40-437Z.pdf` 157KB)

**Total tools: 324** · **CORE 128** (jendela Groq; 9router membawa 64 = chain analisis) · **85 playbook** · **vitest 546** · 2026-09-19→22: `exploit_chain` (9 chain, batch), Tier-1 suite (`race_attack`/`graphql_hunt`/`cache_poison_prover`/`xxe_chain`/`open_redirect_chain`/`ws_hunt`/`github_osint`/`har_import`), `workflow_fuzz`, `js_deobfuscate`, `prompt_injection_hunt`, **`llm_hunt`**/**`mcp_hunt`** + honesty/delivery guards (lihat §9).

---

## 9. Attack completeness & honesty guards (2026-09-19 → 2026-09-21)

Melengkapi §8 (Superpower Suite) — semuanya scope-gated `targetAllowed`, bounded, sinyal jujur (sinyal ≠ vuln; selalu `poc_verify` → `finding_add`).

### 9.1 Exploit Chain Builder — `exploit_chain` (write, confirm, CORE)

Satu konfirmasi untuk rantai serangan umum; `chain` menerima **daftar koma-terpisah** (batch dijalankan berurutan; token tak dikenal → `⛔ CHAIN TIDAK DIJALANKAN`, Ringkasan `X chain dengan langkah nyata · Y dilewati`):

| Chain | Pipeline | Temuan |
|---|---|---|
| `idor` | content_discover → baseline → `bola_diff` A/B → field diff | BOLA/IDOR (CVSS 7.5) |
| `auth_bypass` | decode JWT → alg:none → claim tampering (role/user_id) | auth bypass (9.8) |
| `ssrf` | param_discover → `oast_create` → inject payload → `oast_poll` | SSRF/OAST (7.5–10) |
| `session_fixation` | GET login (pre) → POST login (post) → banding session id | session fixation (7.4) |
| `race` | wrapper `race_attack` (N paralel + NONCE) | duplicate-creation |
| `graphql` | wrapper `graphql_hunt` (introspection/suggestions/batching/depth) | batching+depth kandidat |
| `xxe` | auto-OAST → inline file-read/OOB/param-entity/PHP filter | XXE (passwd TERBACA) |
| `open_redirect` | wrapper `open_redirect_chain` (19 param, host-based verdict) | open redirect |
| `cache_poison` | wrapper `cache_poison_prover` (host-header/fat-GET, STRONG bila cacheable) | web cache poisoning |

Guard `chainRunClaimSuffix` (agent.ts): reply mengklaim sukses padahal output menunjukkan 0 chain jalan → catatan jujur ditambahkan.

### 9.2 Tier-1 Attack Suite (write, confirm; `github_osint`/`har_import` read, auto)

| Tool | What |
|---|---|
| `race_attack` | ≤30 request paralel + **NONCE unik** per request (`{{NONCE}}`) → bukti duplicate-creation; `raceClassify` pure-tested. PRO `race`. |
| `graphql_hunt` | introspection → field-suggestion mining (`Did you mean`, `parseSuggestions`) → alias ganda → JSON-array batching (`batchVerdict`) → depth probe. PRO `graphql_probe`. |
| `cache_poison_prover` | matriks X-Forwarded-Host/X-Host/X-Original-URL/X-Rewrite-URL/X-Forwarded-Scheme/Port + fat-GET (POST + `X-HTTP-Method-Override: GET`) + param refleksi (`utm_*`/`callback`/`next`/`redirect`/`url`); `cacheProbeSignals` (x-cache/age/cf-cache-status) → pantulan+cacheable = **STRONG**. |
| `xxe_chain` | auto-OAST → 4 payload (file-read `/etc/passwd` inline, OOB entity, param-entity OOB, PHP filter); `xxeSignals`; marker `{XXE}` di `body_template`. |
| `open_redirect_chain` | 19 param umum × bypass (scheme-less `//host`, userinfo, `%2f`), ≤40 request, **break per param**; `redirectVerdict` host-based (echo query-string ≠ redirect). |
| `ws_hunt` | handshake RAW node:http (tanpa Origin / Origin evil / Origin target) → `cswshVerdict` (evil 101 + control 101 = Origin tidak divalidasi); opsi `tab` = CDP `new WebSocket` dari browser user (cookie asli, secret tetap di browser). PRO `ws_probe`. |
| `github_osint` | OSINT publik: grep.app code dorks per domain + GitHub commit-history secret scan; nilai rahasia SELALU disensur (`scanTextSecrets`). |
| `har_import` | tempel HAR DevTools → dedup ×N, param union, cookie ∪ Set-Cookie, Authorization (nilai dimask) → `save_session=<nama>` siap `bola_diff`/`auth_matrix`/`http_request`. |

### 9.3 Business-logic fuzz — `workflow_fuzz` (write, confirm, CORE)

State-transition fuzzer di atas primitif flow: happy-path flow ≥2 langkah (login→cart→checkout→refund) lalu mutasi **skip/repeat/reorder/value** (qty -1/0/99999, amount 0/0.01/negatif, currency XXX, coupon reuse), bounded ≤14; `classifyMutation` (double-processing / missing-state-validation / info / ditolak) → sinyal → `poc_verify` → `finding_add` (CWE-840/841). Prompt BUSINESS LOGIC: WAJIB di tiap full pentest aplikasi transaksional.

### 9.4 JS deobfuscation — `js_deobfuscate` (read, auto, CORE)

Eval-free: string-array webpack/obfuscator.io (Pass A collect / B accessor / C replacement), concat multi-baris (foldConcats 8 pass), **source-map restore** (`sourcesContent` inline/`.js.map` dengan atribusi file `← api.ts`). Bounded (≤900KB, ≤8 pass, array ≤2000, map sources ≤120). Gunakan setelah `js_mine` menghasilkan sedikit endpoint dari bundle besar/minified.

### 9.5 LLM prompt-injection — `prompt_injection_hunt` (write, confirm, CORE)

Probe endpoint LLM/agent terhadap prompt injection (delimiter confusion, indirect injection, role override) dengan payload terukur; sinyal jujur, bukan klaim eksploit.

### 9.6 LLM red-team — `llm_hunt` + MCP server audit — `mcp_hunt` (write, confirm, CORE)

**`llm_hunt`** (melengkapi `prompt_injection_hunt`): probe endpoint LLM/agent dengan **5 kelas DEEP red-team**, auto-petakan ke OWASP LLM Top 10 2025:
- **jailbreak** → LLM01: DAN/UnGPT/VOID/role-pivot "ignore all instructions"; hit = marker game-on direspons ATAU refusal hilang vs baseline.
- **rag** → LLM01+04+08: injeksi INDIRECT lewat "retrieved document" (konteks retrieval dipercaya but tidak tepercaya); hit = token `RAG_OBEY_<canary>` ditaati (STRONG deterministik).
- **agency** → LLM06+11: model diminta aksi kuat (send_email/delete_user/transfer/exec) tanpa konfirmasi; hit = marker approval di-echo ATAU tool-call JSON menamai tool kuat.
- **exfil** → LLM02+05: CANARY (fake secret) disemai di prompt, disuruh kirim/echo; hit = canary muncul di respons (STRONG) ATAU beacon OAST (`callback` opt) via `oast_poll`.
- **pii** → LLM02: NIK/email/phone seed; hit = nilai seed di-echo (STRONG).
Semua **baseline-controlled** (marker yang sudah ada di respons benign = bukan sinyal), **trivial-echo suppressed** (`trivialEcho`), bounded ≤40 request, concurrency 4, seed `llmCanaryFromSeed`, GET (param) / POST (`body_field`) didukung.

**`mcp_hunt`**: audit server **Model Context Protocol** (JSON-RPC 2.0 HTTP / legacy SSE) = surface SUPPLY-CHAIN (tool output & resource content dikonsumsi LLM):
1. discovery `initialize` (protocol 2025-06-18) di kandidat (`mcpCandidates` root+/mcp+/sse), fallback SSE legacy.
2. inventory `tools/list`+`resources/list`+`prompts/list` — **anon-access** signal saat tanpa session/auth.
3. **sensitive-tool** exposure (`mcpSensitiveTool`: exec/shell/delete/transfer/admin/secret…) — HANYA dilist, tak pernah dipanggil.
4. **arg injection** ≤2 tool NON-sensitif dengan string param — marker echo = input→output tanpa sanitasi (hasil akan dikonsumsi LLM); callback OAST opsional sebagai nilai arg.
5. **resource scan** ≤2 teks — `scanTextSecrets` (nilai REDACTED) + `mcpInstrSignals` (ignore-previous/system_reminder/<system>) → LLM01/08/11 via konten resource.
Sinyal → `poc_verify` → `finding_add` (OWASP LLM01/02/03/04/05/06/08/11).

### 9.7 Honesty & delivery guards (agent.ts, semua kanal)

1. **Delivery guard** (choke point setelah assistant `tool_calls`): tool di luar `toolsForUrl(url)` (jendela provider) dijawab placeholder jujur "not available on this provider (tool budget)" + tool pengganti; `toolCalls2` di-reassign ke subset ter-delivery → **tidak ada jalur** (confirm/auto-approve/verbatim/execute) yang bisa menjalankan tool di luar janji delivery. **TOOL BUDGET hint** menyisipkan daftar tak-ter-delivery ke prompt (provider capped) + "langsung kerjakan dengan tool yang tersedia" + **PENGECUALIAN PDF** (user minta PDF → sistem buat otomatis via `tryDeliverReportPdf`, dilarang bilang "tidak aktif").
2. **`toolRunClaimSuffix`** (honesty, 11 unit lock): klaim eksekusi tool di prosa tanpa deklarasi `tool_calls` / hasil placeholder (`Not selected`/`Not executed`/`Auto-declined`/"not delivered") → catatan jujur `(Catatan jujur: hasil eksekusi X tidak tercatat di giliran ini — belum benar-benar kujalankan…)` cap 3 tool; `TOOL_CLAIM_EXEMPT` = tool deterministik (remind_me, plan_create, monitor_add, spotify_*, report_*, mood_log).
3. **`pdfDeliverableSuffix`** (fabrikasi penuh): reply mengutip `report-*.pdf` tanpa tool report → note "tidak ada file PDF-nya"; bila user minta PDF dan tak ada tool report, `tryDeliverReportPdf` **membuat PDF nyata** sekarang.
4. **`metaProse.ts`**: prosa stage-direction ("Beri tahu Mas Naufal …") → koreksi hangat deterministik.
5. **CORE invariant runtime** (verify.ts): CORE=128 unik ter-resolve; jendela 9router-64 membawa chain analisis (`workflow_fuzz`, `race_attack`, `graphql_hunt`, `prompt_injection_hunt`, `http_request`, `poc_verify`, `finding_add`, …) — silent-shrink tak bisa lolos.
6. **`composeBuildClaimSuffix`** (2026-09-22): path artefak `-exploit.(mjs|py|sh)` yang dikutip tanpa build, narasi "terbukti penuh" di atas verdict PUTUS/TAK TERSAMBUNG, narasi "sudah kubuat" di atas "tidak dibuat" → catatan jujur (last-verdict-wins, diam bila mengakui/membuktikan; 7 unit lock + blok verify).

### 9.8 Chain composer + exploit artifact + session wizard (2026-09-22 → 2026-09-23)

- **`vuln_compose`** (write/confirm, CORE 105/106): ≥2 temuan PROVEN satu host → hop output-A → input-B deterministik → replay `pocVerify` per hop → komposit critical hanya bila semua STABIL.
- **`exploit_build`** (write/confirm, CORE): replay target dari evidence → script standalone deterministik (node/python/curl) + OAST beacon opsional → file atomik `.data/users/<u>/exploits/`; "tidak dibuat" tanpa file bila tak proven/luar scope.
- **`auth_setup`** (write/confirm, CORE slot 80): login ≤4 akun → sesi bernama siap (`session_a/b`); password masked; scope + headless-guarded.
- **Audit 2026-09-23** (semua kanal): IDOR per-hop scope-gate + anon publicity control; auth_bypass no-token control (publik = info); secret-evidence redact (MCP/GitHub/HAR); sinyal OOB/callback → info `ⓘ`; `learningIngest` SSRF guard (`isPrivateIp` + redirect re-check); `matrixSame` digest + default granted 2xx; `report_pdf`/`finding_resolve` risk→write; confirm-path re-gate (delivery+headless); round budget 10 khusus pentest; `sanitizeHttpUrl`; link-capture gate `isPentestAsk`.

### 9.9 Exposure scanner + CSRF/mass-assignment provers (2026-09-23)

- **`exposure_hunt`** (write/confirm, CORE slot `oast_stop`): 24 path predictable GET-only per origin — LEAD (200+marker) / info (401/403) / diam (404); secret values never printed (keys only); konkurensi 4.
- **`csrf_prove`** (write/confirm, CORE slot `domain_audit`): parse form state-changing + field token + posture SameSite → replay aksi TANPA token memakai session → diterima = kandidat (PoC HTML standalone ke evidence, file nyata) / ditolak = terkontrol; PROVEN / TOKEN-ENFORCED / NO-FORMS; bounded (≤8 form × 3 request).
- **`mass_assignment`** (write/confirm, CORE slot `csp_audit`): injeksi 7 field privileged ke POST/PUT/PATCH + diff vs baseline sesi yang sama (echo baru / outcome berubah); opsional `verify_url` konfirmasi persistensi (TERKONFIRMASI PERSISTEN vs refleksi sesaat); bounded.
- **`upload_fuzz`** (write/confirm, CORE slot `sast_scan`): matriks bypass upload benign + verifikasi akses marker; LEAD / UNVERIFIED / REJECTED; tanpa webshell/.htaccess; scope-gated.
- **`idor_enum`** (write/confirm, 9router-64): enum ID dua-sesi + kontrol anon; guard request/hit.
- **`host_header_hunt`** (write/confirm, groq-only): 8 header × canary + reset-poisoning.
- **`recon_full`** (write/confirm, 9router-64): pipeline recon 6-tahap satu konfirmasi.

---

*Files:* `apps/web/src/lib/security.ts` · `securityWatch.ts` · `engagement.ts` ·
`recon.ts` · `securityPlaybook.ts` · `netGuard.ts` · `apps/web/src/lib/tools.ts`
(registry) · `apps/web/security-playbooks/` (adapted from Strix, Apache-2.0) ·
`labs/pentest/` · `apps/web/src/lib/exploitChains.ts` · `proAttack.ts` ·
`graphqlHunt.ts` · `wsHunt.ts` · `githubOsint.ts` · `harImport.ts` ·
`workflowFuzz.ts` · `jsDeobfuscate.ts` · `promptInjection.ts` · `metaProse.ts` ·
`llmHunt.ts` · `mcpHunt.ts` · `vulnCompose.ts` · `exploitBuild.ts` · `authSetup.ts` · `exposureHunt.ts` · `csrfProve.ts` · `massAssign.ts` · `smuggleProbe.ts` · `domXssProve.ts` · `teamcityCheck.ts` · `bypass403.ts` · `otpProbe.ts` · `protoPollute.ts`.

### 9.10 XSS orchestrator + smuggling/DOM provers (2026-09-23)
- **`xss_hunt`** (write/confirm, CORE slot `request_save`): reflect + konteks + breakout/OAST correlate; refleksi saja bukan bukti. Scope-gated, bounded (≤8 titik × 3 payload).
- **`smuggle_probe`** (write/confirm, CORE slot `edit_file`, groq-only): request smuggling CL.TE/TE.CL/TE-obfuscation via RAW socket (fetch tak bisa emit byte CL+TE ambigu); hidden canary + victim request → CONFIRMED/SIGNAL/REJECTED/NO-DESYNC (count-based, jujur). Scope-gated, bounded ≤3 mode.
- **`dom_xss_prove`** (write/confirm, CORE slot `exec_write`, groq-only): bukti dinamis DOM-XSS di Chromium headless per sumber hash/search/postMessage/window.name/referrer → PROVEN/INJECTED_ONLY/NOT_CONFIRMED; melengkapi `dom_taint` (statik). Scope-gated, bounded ≤5 sumber.
- **`teamcity_check`** (read/auto, CORE slot `reschedule_task`, groq-only): deteksi CVE-2026-63077 TANPA exploit — fingerprint versi vs 2025.11.7/2026.1.3 → version-match = bukti finding_add CWE-502. Rantai RCE full DITOLAK sebagai tool (weaponisasi).
- **`bypass403`** (write/confirm, CORE, groq-only): matriks bypass 403/401 — path (%2e, //, /..;/, trailing ./;), X-Original-URL/X-Rewrite-URL, loopback headers, verb override, _method body; verdict host-based (2xx + body beda dari deny = LEAD; SPA catch-all body-sama bukan temuan). Bounded 20.
- **`otp_probe`** (write/confirm, CORE, groq-only): rate-limit + oracle OTP (bounded ≤15 kode salah, BUKAN brute) + entropy code-space dari samples milik user; no-rate-limit + space kecil = HIGH-signal (CWE-307/330).
- **`proto_pollute`** (write/confirm, CORE, groq-only): prototype pollution server (query+JSON __proto__/constructor.prototype; STRONG bila marker muncul/persisten) + client gadget (source→merge sink) (CWE-1321).
