# Phase 6 Implementation

Phase 6 keeps the Phase 1-5 booking, availability, PostgreSQL locking, automation, Safe Tool Gateway, confirmation boundary, and admin boundary intact. The new work is additive pilot hardening around real provider wiring, persistent AI state, LINE OA, handoff operations, deployment checks, and observability.

## AI Provider

`src/ai/provider.js` still exposes the same `AIProvider` interface. `MockAIProvider` remains the default for tests and local pilots. `OpenAIProvider` is selected with:

```env
AI_ENABLED=true
AI_PROVIDER=openai
OPENAI_API_KEY=...
AI_MODEL=gpt-5.4-mini
```

The OpenAI implementation only classifies the next receptionist action. It uses the Responses API with a strict function tool named `select_receptionist_action`, then passes that intent back into the existing receptionist service and Safe Tool Gateway. It never reads SQL credentials, never calls repositories directly, and never bypasses the confirmation boundary.

## Persistent Session And Rate Limit

`database/migrations/006_pilot_hardening.sql` adds `ai_sessions`, `rate_limits`, `handoff_requests`, `admin_session_revocations`, and `line_webhook_events`.

`src/ai/persistent-sessions.js` stores the AI booking state in PostgreSQL with owner hashing and row locks. Browser sessions use an HttpOnly owner cookie; LINE sessions use an HMAC-derived owner based on the LINE user id. `src/security/persistent-rate-limit.js` stores fixed-window counters in PostgreSQL so multiple app instances share the same pilot limit.

## LINE OA

`src/messaging/providers.js` defines the generic messaging provider and the LINE implementation. `app/api/line/webhook/route.js` receives webhook payloads, verifies `x-line-signature` with `LINE_CHANNEL_SECRET`, then routes text messages through:

```text
LINE -> Webhook -> AI Receptionist Service -> Safe Tool Gateway -> Booking Core
```

Automation notifications use `src/messaging/line-automation-provider.js`. If a booking has a stored `line_user_id` and LINE is enabled, confirmations, reminders, cancellations, reschedule notices, and follow-ups can be pushed through LINE. Otherwise the existing console/mock provider remains available.

## Human Handoff

The receptionist creates `handoff_requests` when protected or human-only situations arise, such as discount/exception requests. After handoff, the session stops taking protected booking actions and tells the customer that staff will take over. Admin can see pending handoffs at `/admin` and mark them accepted or resolved.

## Verification

`src/security/verification.js` adds a `VerificationProvider` abstraction. Phase 6 uses `PhoneMatchVerificationProvider`, preserving current phone-match behavior while leaving room for OTP later.

## Admin Hardening

Admin login now uses `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET`; plaintext local credentials are no longer read. Sessions are signed, expire, can be logged out, and logout writes a DB revocation so the same cookie cannot be reused. Admin booking, status, handoff, and session routes enforce the same auth boundary.

Generate a password hash with:

```bash
ADMIN_PASSWORD_PLAIN='replace-with-long-password' npm run admin:hash-password
```

## Deployment Readiness

Set `PILOT_STRICT_CONFIG=true` in pilot/production so startup validates required env vars. `GET /api/health` checks database readiness and reports feature toggles without exposing secrets. `docs/PILOT_DEPLOYMENT.md` contains the pilot deployment checklist, migration sequence, worker/scheduler guidance, and LINE webhook setup.

## Tests

The Phase 6 tests cover mock and real provider abstraction, persistent session restore, owner isolation, DB-backed rate limiting, LINE signature handling, LINE booking flow, handoff creation, admin route protection/logout, config validation, automation regression, and existing Phase 1-5 regression behavior.
