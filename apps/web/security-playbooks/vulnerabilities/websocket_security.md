<!--
Original Mia knowledge pack (no external source). Knowledge only — not code.
Mia tool mapping: handshake/messages→ws_probe, HTTP upgrade→http_request, OAST→oast_create/oast_poll,
session headers/cookies→http_session, PoC→poc_verify, log→hunt_log, report→finding_add + writeup.
-->
---
name: websocket-security
description: WebSocket testing — cross-site hijacking, missing message authorization, IDOR over sockets
---

# WebSocket Security

A WebSocket is an HTTP upgrade followed by a long-lived, bidirectional channel. Two mistakes dominate: the handshake is not protected **(no Origin check, no CSRF protection)** and message handlers trust the client because "the socket is authenticated". Every message is a fresh request that needs its own authorization decision.

## Attack Surface

- `GET` upgrade to `Upgrade: websocket` (`/ws`, `/socket`, `/socket.io/`, `/cable`, `/realtime`, `/graphql`)
- Socket.IO/Engine.IO poll fallback (`/socket.io/?EIO=4&transport=polling`) — often missed by proxies
- Server-sent events next to the socket (`/events`) with the same data
- Subprotocol extensions (`Sec-WebSocket-Protocol`) and message sub-types (`{type:"..."}`)

## High-Value Targets

- Chat/DM, notifications, presence
- `subscribe`/`join` channels (`{"action":"subscribe","room":"<id>"}`)
- Live location/order tracking, trading/account feeds
- Admin/monitoring consoles

## Reconnaissance

1. Find the upgrade URL and the exact handshake headers (`http_history` + `http_request` with `Upgrade: websocket`).
2. Observe frames: server→client event names reveal features; client→server frames reveal actions and IDs.
3. Check whether **messages** carry a session token separate from the handshake cookie.
4. Look for numeric/sequential IDs in messages (`roomId`, `userId`, `docId`) — IDOR candidates.

## Key Vulnerabilities

### Cross-Site WebSocket Hijacking (CSWSH)

The browser sends cookies on the handshake and **does not apply CORS**. If the server does not validate `Origin`, an attacker page can open a socket as the victim and read/write their data.

Test: replay the handshake from a different `Origin` (`http_request` with `Origin: https://evil.example`). If the upgrade succeeds (101), CSWSH is likely — prove it by reading a victim-scoped message.

### Missing per-message authorization

The handshake authenticates the *connection*, but actions often never re-check ownership:

- `{"action":"subscribe","room":"<other-user-room>"}` → receive someone else's messages
- `{"action":"get","id":<other-id>}` → read a record you do not own
- `{"action":"update","id":<other-id>,...}` → write to someone else's record

Use two accounts and swap only the identifier (do not touch the token) — `bola_diff` (session A vs B) is the cleanest proof.

### Token/credential leakage in URLs

`wss://host/ws?token=...` leaks via proxies, referrers, and logs; tokens in query strings are also replayable across origins.

### Unauthenticated or weak authentication

- No `Sec-WebSocket-Protocol`/subprotocol auth (some stacks authenticate via a subprotocol value)
- "Auth by first message" (`{"type":"auth","token":...}`) with no failure close, or an auth timeout
- Accepting any handshake then trusting a client-supplied `userId`

### Injection through socket messages

Whatever the message carries reaches a backend (SQL/NoSQL, command, template). Test with the same payloads as HTTP — the transport does not sanitise anything.

### Resource and rate issues

Unbounded `subscribe`, no message size cap, no per-connection rate limit → memory/CPU exhaustion. Report only with a minimal, non-destructive proof (respect RoE; no flooding).

## Testing Methodology

1. Capture the handshake and one full message exchange (`ws_probe`).
2. Replay the handshake with a foreign `Origin`.
3. Swap identifiers across two sessions; check both read and write paths.
4. Fuzz message fields with the standard payload set (reflection, SQL syntax, template expressions, path traversal).
5. Test the poll/SSE fallback transport — proxies often enforce less there.
6. Check the close path: what happens on auth failure, and can a socket be reused after logout?

## Validation

- 101 Switching Protocols to a foreign `Origin`, plus a message containing victim-only data.
- Cross-account read/write with only the ID changed (token untouched) — show before/after state.
- Reproducible frames (same input → same output) for `poc_verify`; include the raw frames as evidence.
- For blind injection, a callback via `oast_create` inside the message payload.

## False Positives

- Upgrade rejected (403) for foreign origins, or `Origin` validated server-side
- Data returned belongs to the authenticated session that sent the request (no IDOR)
- A "leak" that is public broadcast data by design
- Rate/size limits present but generous — note as hardening, not a finding

## Impact

- Account takeover via CSWSH (read tokens/messages, perform actions as the victim)
- Cross-tenant data exposure or tampering (IDOR over sockets)
- Unauthenticated access to internal event streams
- Denial of service through unbounded subscriptions

## Pro Tips

1. Always test the handshake's `Origin` first — it is one request and often the finding.
2. Sockets frequently bypass the HTTP layer's authz middleware; re-use your HTTP IDOR tests over the socket.
3. Check the `transport=polling` fallback with the same payloads.
4. If the handshake requires a CSRF token, verify it is actually validated (drop/blank it and retry).
5. Log the exact frame sequence — reviewers must be able to replay it.

## Summary

Treat every frame as an HTTP request: who is it from, and does the server re-check ownership? A socket that is authenticated at upgrade but unauthorized per message is the same IDOR class you test on REST.
