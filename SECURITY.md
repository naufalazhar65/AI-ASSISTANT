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

**75 packs across 11 categories** live in
`apps/web/security-playbooks/<category>/<name>.md`, **adapted from
[Strix](https://github.com/usestrix/strix) (Apache-2.0)**:

- `methodology` — application-security-testing (AppSec end-to-end), owasp-top-10-testing (**OWASP Top 10:2025**), api-security-testing (**API Top 10:2023**), whitebox-code-review, fix-and-verify, source-aware-whitebox
- `scan_modes` — scan-modes (quick / standard / deep / diff)
- `analysis` — counterevidence, severity-calibration, fix-verification, source-aware-discovery
- `vulnerabilities` (×28) — ssrf, idor, xss, sql_injection, ssti, xxe, csrf, race_conditions, http_request_smuggling, authentication_jwt, mass_assignment, path_traversal, nosql_injection, insecure_deserialization, prototype_pollution, business_logic, subdomain-takeover, llm-prompt-injection, …
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

*Files:* `apps/web/src/lib/security.ts` · `securityWatch.ts` · `engagement.ts` ·
`recon.ts` · `securityPlaybook.ts` · `netGuard.ts` · `apps/web/src/lib/tools.ts`
(registry) · `apps/web/security-playbooks/` (adapted from Strix, Apache-2.0) ·
`labs/pentest/`.
