# ADR-0005: Short-lived ES256 access tokens + rotating opaque refresh tokens with reuse detection

- **Status:** Accepted (requirements §24; proposal §M.1)
- **Date:** 2026-10-06

## Decision
- **Access token:** JWT, ES256 (algorithm pinned on verify; `alg:none`/HS256 confusion rejected, tested), 15 min TTL, claims `sub` (user) + `sid` (session).
- **Per-request session check:** the global `AuthGuard` loads the session and user row on every request, so logout, session revocation and suspension take effect **immediately**, not at token expiry. Cost: one indexed lookup per request — acceptable at the planned scale (assumption S2); revisit with measured data.
- **Refresh token:** 256-bit opaque value, only its SHA-256 stored, **rotated on every use**. A session is the refresh-token family.
- **Reuse detection:** presenting an already-rotated token outside a 10 s grace window revokes the entire session (theft signal, audited). Inside the grace window the response is `409 REFRESH_CONFLICT` without revocation, to tolerate a client retrying after a lost response. Trade-off: that client must log in again.
- **OTP:** 6 digits, stored only as HMAC bound to the challenge id; 5-minute TTL; ≤5 attempts per challenge; only the newest challenge is valid; per-phone and per-IP hourly throttles plus a resend cooldown (Postgres counters — no Redis in v1); failed attempts are committed (the verify transaction *returns* rather than throws on mismatch).
- **Not yet implemented:** password + TOTP MFA for privileged accounts (see PHASE-1-STATUS). Until then the admin API is reachable with OTP login alone and **must not be exposed outside development**.

## Consequences
- Dev/test generate ephemeral signing keys; tokens do not survive a restart. Production refuses to start without real keys.
- `req.ip` relies on `trust proxy = 1` (behind the ALB). The API must not be exposed directly, or `X-Forwarded-For` could be spoofed to evade IP throttles.
