# Skill: Auth

> Authentication security — login bypass, JWT attacks, OAuth flaws, session fixation, 2FA bypass, account recovery, and OTP oracle testing.

## Tools
- **auth_hunt**: Probe login/register/forgot/reset/providers/csrf/openid
- **jwt_attack**: JWT decode/forge alg:none/HS256/alg-confusion/crack weak secret
- **oauth_hunt**: OIDC discovery + redirect_uri bypass variants
- **ato_prove**: Prove account takeover from leaked credentials (login → session → protected page)
- **auth_matrix**: N-role permission matrix (admin/user/guest × endpoints)
- **otp_hunt**: 2FA bypass (leak/no-validation/reuse/cross-account/field-confusion)
- **otp_probe**: OTP rate-limit + oracle + entropy analysis
- **account_recovery**: Password reset poisoning (host injection, token predictability, user enumeration)
- **session_fixation**: Session fixation chain (pre/post session compare)
- **auth_setup**: Login up to 4 accounts → sessions for bola_diff/auth_matrix

## When to Use
- When target has authentication (login, register, OAuth, 2FA)
- When user says "auth test", "JWT", "OAuth", "2FA bypass", "account takeover", "session"
- After recon: testing auth surface

## Rules
- All active probes are scope-gated (lab / engagement / PENTEST_LAB_TARGETS)
- auth_setup requires real credentials (owner provides them)
- Never brute-force passwords (otp_probe uses bounded wrong codes, not brute)
- Record confirmed auth bypass to target_brain + finding_add

## Output Format
Use shared finding schema. Auth findings: A07 (Identification & Auth Failures), A01 (Broken Access Control).

## Workflow
1. `auth_setup` → create sessions for testing
2. `auth_hunt` → probe auth endpoints
3. `jwt_attack` → test JWT weaknesses
4. `oauth_hunt` → test OAuth redirect_uri bypass
5. `auth_matrix` → test role/permission matrix
6. `otp_hunt` / `otp_probe` → test 2FA
7. `ato_prove` → prove account takeover chain