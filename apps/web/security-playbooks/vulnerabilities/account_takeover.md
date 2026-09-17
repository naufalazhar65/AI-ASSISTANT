<!--
Original Mia knowledge pack (no external source). Knowledge only — not code.
Mia tool mapping: flow multi-step→flow_run, request capture→http_history/http_session,
token brute force→param_fuzz (bounded!), OAST→oast_create/oast_poll, proof→poc_verify,
track→hunt_log, report→finding_add + writeup (impact-first).
-->
---
name: account-takeover
description: Account takeover chains — password reset, OTP/MFA, email change, session fixation, host-header poisoning of reset links
---

# Account Takeover

ATO is usually a *chain*, not a single bug: one weak step (predictable reset token, host-header poisoned reset link, OTP without lockout, email change without re-auth) is enough, and the fixes for each are independent. Enumerate every path that can change a credential, an email/phone, or a session.

## Attack Surface

- Password reset / "forgot password" (request + consume)
- Email/phone change, invite links, magic links, "verify your email"
- OTP/MFA: enrolment, verification, disable, recovery codes, "remember this device"
- OAuth/OIDC/social login linking and unlinking
- Session lifecycle: login, logout, "log out everywhere", remember-me cookies
- Support flows: "change my email" requests, admin impersonation

## High-Value Targets

- Reset link generation and consumption (the classic ATO path)
- Email-change endpoints (change email → reset password → own the account)
- MFA disable/enrolment without re-authentication
- Any endpoint that accepts a token/OTP derived from user data

## Reconnaissance

1. Map the entire reset flow with `http_history` (request → email → consume) and record tokens, prefixes, lengths, expiries.
2. Note which values are reflected into the reset email/page — a very common host-header poisoning path.
3. Check for user enumeration: reset/login/register responses that differ in text, status, or timing for known vs unknown accounts.
4. For OTP, record the code length, alphabet, expiry, and whether failures are counted.

## Key Vulnerabilities

### Reset token weaknesses

- **Low entropy / predictable**: sequential IDs, `md5(email)`, `base64(userId:timestamp)`, timestamps with seconds
- **Not invalidated**: old tokens still work after a new request, after login, or after the password changed
- **Not bound to the user**: token from account A accepted on account B, or reusable across accounts
- **Leaked in transit**: token in the URL → sent in `Referer` to third parties; token in an email opened via a proxy/webmail preview
- **Long/no expiry**, or expiry enforced only client-side

### Host-header poisoning of reset links

If the reset email is built from the request's `Host`/`X-Forwarded-Host`, ask for a reset while sending your own host. The victim receives a **legit email** whose link points at your domain → their click hands you the token. This is one of the most reliable ATO chains.

### Email/phone change without re-auth

- `POST /settings/email {newEmail}` accepted without current password or confirmation → change email, then reset password
- Confirmation link sent to the *new* address only, or the change applied immediately (race the confirmation)
- Case/Unicode/alias tricks (`user+attacker@`, `USER@`, trailing dot) to bypass uniqueness and receive mail

### MFA bypass

- Enrolment/disable endpoints lacking re-authentication
- OTP verification performed against *any* user's code, or code accepted for another user in the same session
- No rate limit / lockout on OTP (brute force a 6-digit code) — **stay bounded and non-disruptive**; prove feasibility with a small sample and stop
- "Remember this device" cookie with a guessable value
- Response/status differences that allow step-skipping (reset the password without completing MFA)

### Session issues

- No session rotation after login/password change → session fixation; the pre-login session becomes authenticated
- Logout does not invalidate the server-side session (old cookie keeps working)
- Remember-me tokens that never expire and are not invalidated by a password change

## Testing Methodology

1. Enumerate every credential/identity-changing flow; diagram each as a state machine.
2. Test the happy path first, capturing tokens and cookies (`http_session`).
3. Attack each transition: who can call it, what does it verify, what does it invalidate?
4. Chain the weakest step — e.g. email change → reset → login.
5. Confirm with a **fresh session** so you are not fooled by your own still-valid cookie.
6. Measure blast radius: one account, or any user?

## Validation

- Reset-token prediction: generate several tokens for the same/adjacent accounts, show the pattern deterministically (hash the outputs).
- Host-header poisoning: show the request with your `Host`, the delivered link (raw email body/headers), and that the token in it works.
- OTP brute force: demonstrate a small bounded sample plus the absence of a lockout; never run a full sweep.
- Session fixation: capture the cookie before and after login and show the same identifier is now authenticated.
- Use `flow_run` to replay the whole chain as one reproducible proof, then `poc_verify` for the final step.

## False Positives

- Tokens that are random, single-use, bound to the account, short-lived — the intended design
- Enumeration differences that are explained by unrelated rate limiting
- `Host` reflected but the email link is rewritten to a fixed origin server-side
- MFA bypass that requires a stolen session in the first place (not an ATO primitive)

## Impact

- Full account takeover (data, funds, linked services, impersonation)
- Mass takeover when the weakness is a predictable token or a shared host-header pattern
- Persistent access via email change + password reset even after the user notices

## Pro Tips

1. **Chain, don't stop at the first weak response** — a low-severity email change plus a reset is a critical ATO.
2. Always re-test tokens after requesting a new one; "not invalidated" is cheap and common.
3. Read the reset email headers (`oast_create` for a controllable mailbox) — the token often leaks in `Referer`/tracking pixels too.
4. Compare responses for two real accounts you control; never brute-force a real user.
5. Report the *impact* (takeover) with the minimal reproducible chain, and state clearly which single fix breaks it.

## Summary

Takeover research is state-machine work: for every flow that changes identity or credentials, ask who may call it, what it verifies, and what it invalidates. Then demonstrate the shortest chain to a fresh, authenticated session.
