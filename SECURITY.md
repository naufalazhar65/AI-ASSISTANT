# 🔐 Mia — Cybersecurity / Ethical-Hacker Toolkit

Mia can act as a **defensive / authorized** security assistant: audit your own
machine & code, run permitted scans, track findings, and produce client-ready
reports. Everything here is **keyless** by default and runs on the owner's Mac.

> **Scope & ethics (hard rule).** Only test systems you own or have **written
> authorization** for. Active scans are limited to `localhost`, RFC1918/private
> hosts, an **active Engagement** scope, `PENTEST_LAB_TARGETS`, or the two
> explicitly scan-permitted public hosts. Public third-party demos (e.g.
> `itsecgames.com`/bWAPP online, TryHackMe, Hack The Box, PortSwigger) are **not**
> targets — use them as learning material only. Mia cannot verify legality; the
> Engagement record (client + authorization reference) is your audit trail.

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
| `web_audit` | one GET → security headers present/missing, cookie flags, server banner, score |
| `domain_audit` | SPF, DMARC(+policy), DKIM (common selectors), CAA, MX, NS |
| `exec tcpdump -r / nc -z / searchsploit` | read a pcap (`-r`; capture needs sudo), port check (`nc -zv host port`), Exploit-DB lookup |

### 2.3 Active scanning (write → confirm; scope-enforced)
| Tool | Tools used | Scope |
|---|---|---|
| `pentest_scan` | `nmap`, `nuclei` (`-as`), `nikto`, `ffuf`/`gobuster` (built-in wordlist), `whatweb` | lab/engagement/permitted only |
| `http_request` | raw HTTP (method/headers/body) for API testing (REST/GraphQL/mass-assignment) | lab/engagement only |
| `sqlmap_scan` | `sqlmap` (SQLi) | lab/engagement only |
| `zap_scan` | OWASP ZAP baseline (Docker) | lab/engagement only |

Targets outside scope are **rejected** (`isLabTarget` / engagement scope).

### 2.4 Analysis (read, auto)
| Tool | What |
|---|---|
| `password_strength` | local entropy + common-pattern check (args redacted) |
| `hash_identify` | detect hash type + compute sha256/sha1/md5 |
| `jwt_inspect` | decode JWT + flag `alg=none` / expired |
| `ioc_extract` | IP/domain/URL/email/hash from text (handles `hxxp`/`[.]` defang) |
| `cvss_score` | CVSS v3.1 base score from a vector (e.g. `…/C:H/I:H/A:H` → 9.8) |
| `encoding` | base64 / url / hex / html / rot13 encode–decode |

### 2.5 Dependencies (read, auto)
| Tool | What |
|---|---|
| `dep_audit` | CVE audit via **OSV** (npm `package-lock.json` + PyPI `requirements.txt`); shows **nearest fixed version**; `to_findings=true` adds to board |
| `verify_patch` | compare installed versions vs each dep finding's fixed version → patched / still / unverified; `apply=true` auto-resolves patched |
| `trivy_scan` | filesystem/image CVE scan (keyless; `brew install trivy`) |

### 2.6 Findings & reporting (read, auto)
| Tool | What |
|---|---|
| `finding_add` | record a finding (Title/Severity/**CVSS**/OWASP/CWE/Target/Steps-to-Reproduce/Evidence/Impact/Root-Cause/Remediation/References) |
| `finding_list` | open findings sorted by CVSS |
| `finding_resolve` | mark a finding resolved (drops from lists/plan/report) |
| `finding_export` | open findings → **CSV / JSON / SARIF 2.1.0** under `.data/users/<user>/reports/` |
| `hardening_plan` | CVSS-prioritized remediation plan |
| `report_generate` | markdown pentest report (incl. active Engagement header) |
| `report_save` / `report_pdf` / `hardening_pdf` | write MD / render PDF (via Playwright) |

### 2.7 Lab lifecycle
| Tool | What |
|---|---|
| `lab_status` / `lab_start` / `lab_fetch` | start/stop/status the local lab; `lab_fetch` GETs a **lab/authorized** URL (bypasses the public SSRF guard for your own lab) |

### 2.8 Engagement & Scope (client authorization)
| Tool | What |
|---|---|
| `engagement_create` | record `name`, `client`, `authorization` (PO/contract/email), `scope[]`, `out_of_scope[]`, `window_start/end`, `contact`, `notes` |
| `engagement_list` / `engagement_close` | manage engagements |
| `pentest_resources` | practice platforms + local lab URLs + scope reminder |

Once an engagement is **ACTIVE**, hosts in its `scope` become scannable by
`pentest_scan` / `sqlmap_scan` / `zap_scan` / `lab_fetch`; out-of-scope is
refused.

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
  `PENTEST_LAB_TARGETS` + 2 permitted public hosts).
- **FR-014 confirmation** for scans/edits; read-only tools auto-run.
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
`apps/web/src/lib/tools.ts` (registry) · `labs/pentest/`.
