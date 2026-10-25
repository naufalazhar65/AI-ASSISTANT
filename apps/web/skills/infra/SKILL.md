# Skill: Infra

> Infrastructure security — cloud misconfigurations, TLS hygiene, DNS audit, Bluetooth control, device monitoring, and network-level testing.

## Tools
- **cloud_misconfig**: S3/GCS/Azure Blob listing, Firebase RTDB, Supabase (keyless)
- **tls_check**: TLS certificate hygiene (issuer/expiry/chain)
- **dns_audit**: DNS zone transfer (AXFR), DNSSEC, CAA
- **security_scan**: macOS security posture (FileVault/Firewall/Gatekeeper/SIP/ports)
- **secret_scan**: Walk sandbox dir for exposed secrets (values redacted)
- **bucket_enum**: S3/GCS candidate bucket probe (scope-gated)
- **recon_ports**: Native TCP connect scan on common ports
- **recon_dnsbrute**: DNS wordlist brute-force
- **monitor_add**: Watchlist monitors (price/crypto/weather/device)

## When to Use
- When target has cloud infrastructure (S3, GCS, Azure, Firebase, Supabase)
- When user says "cloud", "TLS", "DNS", "infrastructure", "bucket", "secret scan"
- For infrastructure-level assessment

## Rules
- cloud_misconfig requires base_domain covered by active engagement
- All active probes are scope-gated
- secret_scan walks sandbox root only (never full filesystem)
- Never attack third-party infrastructure

## Output Format
Use shared finding schema. Infra findings: A05 (Security Misconfiguration), CWE-16 (Configuration), CWE-310 (Crypto).

## Workflow
1. `security_scan` → baseline posture
2. `secret_scan` → check for exposed secrets
3. `tls_check` → TLS hygiene
4. `dns_audit` → DNS zone transfer / DNSSEC / CAA
5. `cloud_misconfig` → cloud storage/database misconfig
6. `bucket_enum` → S3/GCS bucket enumeration