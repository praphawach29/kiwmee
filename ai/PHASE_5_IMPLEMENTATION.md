# Phase 5: AI Receptionist and Safe Tool Gateway

## Architecture

Customer -> `/assistant` -> `/api/ai/receptionist` -> Receptionist -> ToolGateway
-> existing Route Handlers -> existing orchestration/core -> PostgreSQL.

AI modules never import pg or a repository. The in-process API transport uses the same
validation, authorization, booking transaction, availability and automation path as HTTP.
Booking core, staff locking and existing availability rules are unchanged.

New modules:
- `src/ai/provider.js`: AIProvider interface and deterministic MockAIProvider.
- `src/ai/receptionist.js`: server-owned dialogue transitions and response rendering.
- `src/ai/sessions.js`: expiring session store, owner check and per-session turn exclusion.
- `src/ai/tools/catalog.js`: eight allowlisted tools with strict JSON input/output schemas.
- `src/ai/tools/gateway.js`: validation, confirmation authorization and safe error mapping.
- `src/ai/tools/api-client.js`: transport to the existing API handlers, no SQL access.
- `src/ai/audit.js`: optional redacted tool metadata logging.
- `src/security/access.js`, `limits.js`: verification, admin sessions, origin/size/rate checks.
- `app/assistant/*`: mobile-first Thai chat, real slot choices, review and result cards.
- `app/api/ai/receptionist/route.js`, `app/api/admin/session/route.js`: new endpoints.
- `app/admin/layout.jsx`, `admin-gate.jsx`: login boundary around the existing admin UI.

Modified files include protected booking/admin API routes, the existing Manage Booking
client's phone verification form, `src/config.js`, automation job repository methods,
worker failure handling, schema, API contract, prompt, package files and `.env.example`.
Tests are in `tests/ai-receptionist.test.js`, `tests/postgres.integration.test.js`,
`e2e/assistant.spec.cjs` and `playwright.config.cjs`.

## Tools and confirmation

The tools are list_services, get_service_details, list_staff, check_availability,
create_booking_request, get_booking, request_reschedule and request_cancel.
All inputs reject extra keys and are validated with Ajv. Outputs also pass schema
validation. Service prices and durations, eligible staff and slots come from the APIs.

Server session stores service/staff/date/slot, customer name/phone, verified booking,
current stage, last returned options and an expiring review. Session ownership requires
an unguessable HttpOnly owner cookie in addition to the public session UUID. It expires
after 30 minutes; reviews expire after 10 minutes. One turn can execute per session.

Selecting a time only advances to contact collection and review. Mutating tools accept
only a review_id, never arbitrary booking fields. The server grants confirmation only
after the customer's next exact `ยืนยัน` message, consumes the review once, and invokes
the API. Provider output cannot grant that permission. On conflict the server fetches
availability again, clears confirmation and reports that booking did not succeed.

## Identity and security

Booking detail/reschedule/cancel require reference plus matching stored phone every
time. The tools cannot use a client-supplied actor to bypass customer cancellation
policy. Public admin listing/status routes are now protected too, preventing a UUID-only
alternate route to private appointments. Admin login uses server ADMIN_PASSWORD and
an eight-hour signed HttpOnly/SameSite cookie; HTTPS adds Secure.

The AI endpoint limits messages to 2000 characters and streams at most 8192 request
bytes. Session creation, conversation turns, verification and admin login have basic
process-local rate limits. Browser cross-origin writes are rejected. System prompts,
raw tool errors and secrets are never returned. AI_AUDIT_LOGGING=true logs only fixed
tool names, outcome and safe error codes; it excludes messages, arguments and contacts.

Provider intent output is untrusted. Responses are rendered from server data and an
allowlisted dialogue, not copied from arbitrary model prose. Complaint, discount,
policy exception and human requests enter handoff state. Pilot handoff explicitly asks
the customer to contact the shop; it does not claim a message was delivered to staff.

The updated `ai/AI_RECEPTIONIST_PROMPT.md` remains the instruction source for a future
model provider. This phase calls no external LLM and needs no model API key. The Mock
supports guided Thai selection, explicit dates/tomorrow, afternoon service queries,
contact collection, booking lookup and confirmation. It is not an unrestricted natural
language model. Add a real provider behind AIProvider only in a later approved phase.

## Automation retries

Apply `database/migrations/005_automation_retry.sql` to Phase 4 databases. It adds
nullable `automation_jobs.dead_lettered_at` and an index, preserving the five existing
job lifecycle statuses. New databases use the updated full schema.

AUTOMATION_MAX_ATTEMPTS defaults to 5. AUTOMATION_RETRY_BASE_SECONDS defaults to 60.
Failures retry after base * 2^(attempts-1) seconds, capped at one hour. Failed reminders
retain their retry schedule rather than having it reset by reminder reconciliation.
At the limit the job remains failed with dead_lettered_at populated and is excluded
from automatic claims. Expired processing leases at the limit are retained similarly.
Jobs and error state are not deleted. Ordinary completed jobs remain idempotent.

Inspect terminal jobs with a trusted database connection:
```sql
select id, booking_id, automation_type, attempts, last_error, dead_lettered_at
from automation_jobs where dead_lettered_at is not null order by dead_lettered_at;
```
Manual replay is an operator decision after fixing the delivery issue. No automatic
dead-letter replay or external alert delivery is enabled. Preserve event keys on any
authorized replay so provider idempotency continues to protect delivery.

## Local trial

Set DATABASE_URL and PGSSL as appropriate. ADMIN_PASSWORD enables the admin login;
an unset password leaves admin access closed. Set AUTOMATION_INTERNAL_SECRET to use
the automation runner. No environment secret uses a NEXT_PUBLIC prefix.

Open `/assistant`, choose ดูบริการ -> ตัดผม -> ช่างแอน -> 2026-09-10 -> a returned time.
Enter `มาลี 0812345678`, inspect the review and click ยืนยัน. A result card appears only
after the API returns a booking. Use the returned reference with:

```text
ดูนัด <booking-id> 0812345678
เลื่อนนัด
ยกเลิกนัด
```

Reschedule and cancel both require another review/confirmation. Try `ขอส่วนลด` to see
handoff. `2026-09-10 ช่วงบ่ายมีคิวตัดผมไหม` tests real afternoon availability. Dates with
no working schedule show an empty state, not invented slots. `/manage/<id>` now asks
for the booking phone; `/admin` asks for the configured password.

## Verification

`npm test` runs deterministic unit tests. With TEST_DATABASE_URL set to an isolated,
disposable PostgreSQL database, it also tests all prior phases plus real AI booking
creation, concurrent conflict/refresh, reschedule history, cancellation policy, UUID-only
denial, actor spoofing denial, admin protection, session ownership and retry/dead letter.
Integration tests reset the test database public schema; never point them at pilot data.

`npm run build` verifies Next.js. `npm run test:browser` uses installed Microsoft Edge
against PILOT_BASE_URL (default http://127.0.0.1:3000), with 390px and 1440px viewports.
It exercises actual APIs, holds confirmation in transit to test absence of premature
success, checks verification and login, and captures artifacts under `artifacts/phase5`.
Browser tests create and cancel their own pilot bookings.

## Pilot limitations and next decisions

- Sessions and rate limits are process-local; use a shared store before multiple server instances.
- Reference plus phone is MVP verification, not proof of phone ownership. Consider OTP or scoped manage tokens before broad launch.
- Admin uses one configured password rather than staff accounts/roles. Rotate the pilot password before sharing.
- Handoff needs a chosen staff contact/inbox before actual escalation delivery.
- Durable provider idempotency remains necessary for the crash-between-send-and-commit window.
- No LINE OA, email, SMS, payment or CRM marketing integration is enabled.
