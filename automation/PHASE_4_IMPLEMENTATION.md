# Phase 4: Booking Automation Engine

## Scope and files

The existing booking rules, availability engine, core booking service and staff locking remain unchanged.
New orchestration composes the existing service and automation writes within one PostgreSQL transaction.

- `src/automation/booking-orchestration.js`: atomic booking and job writes for HTTP mutations.
- `src/automation/transaction-scope.js`: reuse the outer transaction connection.
- `src/automation/automation-service.js`: lifecycle scheduling, reconciliation, no-show detection and worker.
- `src/automation/providers.js`: Console and Mock notification providers.
- `src/repositories/pg-booking-repository.js`: additive job storage, claims, audit and dispatch locking.
- `src/config.js`: server-only automation configuration.
- `app/api/bookings/route.js` and `[id]/{reschedule,cancel,status}/route.js`: use orchestration.
- `app/api/internal/automation/run/route.js`: protected one-cycle runner.
- `scripts/run-automation.js`, `package.json`: vendor-independent command-line runner.
- `database/schema.sql`, `database/migrations/004_automation_jobs.sql`: persistent jobs and indexes.
- `.env.example`: configuration names without real credentials.
- `tests/automation-service.test.js`, `tests/fake-repository.js`, `tests/postgres.integration.test.js`: automation verification.

## Migration

For an existing Phase 3 database, apply only `database/migrations/004_automation_jobs.sql`.
Do not reapply the full schema to an existing database. The migration is additive and repeatable.
For a new database, use `database/schema.sql` and the appropriate seed.

With PostgreSQL tools installed:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f database/migrations/004_automation_jobs.sql
```

`automation_jobs` stores booking_id, automation_type, unique event_key, scheduled_at,
status, payload, attempts, last_error, created_at and updated_at. Status values are
pending, processing, completed, failed and cancelled. Indexes cover due jobs and booking lookup.
RLS is enabled without browser policies: use a trusted server PostgreSQL role.
`automation_logs.event_key` remains unique and records successful executions.

## Architecture and guarantees

HTTP booking mutations call orchestration, which runs core mutation, status history and
job scheduling in one transaction. An enqueue error rolls everything back, including
reminder invalidation during reschedule. There are no external sends in the booking transaction.

Confirmation and reminder event keys contain booking ID and schedule version (staff,
start time and booking update timestamp). This supports same-time staff changes and a
later move back to a previous time while retaining an immutable record of old jobs.
The cancellation and follow-up event keys are per booking. Confirmation is sent only
while the booking is still confirmed and in the future.

A cycle detects no-shows, reconciles missing legacy jobs, refreshes pending reminder
times from current configuration and dispatches due jobs. No-show detection locks and
rechecks each booking before invoking the existing status service; history and follow-up
are atomic. A concurrent check-in or a second detector cannot produce a false no-show.

Claims use `FOR UPDATE SKIP LOCKED`, set processing and increment attempts. Each dispatch
locks the booking and then the job, rechecks status, schedule version, claim attempt and
the success audit before sending. Cancel/reschedule serialize on the same booking row.
Thus a job already claimed before a committed cancellation/reschedule is discarded.
Sending already in progress finishes before the booking mutation commits.

Success writes the audit and completed state together. Provider errors retain the job
as failed with last_error, retried on the next run. Processing claims older than five
minutes are reclaimable after a worker crash. Claim attempts fence obsolete workers;
row locks protect an active dispatch. Retry attempts are currently unlimited, one per cycle.

## Provider contract

Implement asynchronous `sendConfirmation(payload)`, `sendReminder(payload)`,
`sendCancellation(payload)` and `sendFollowUp(payload)`. Payload includes booking IDs,
schedule/status and `idempotency_key`; follow-ups include `followup_type`.
Resolve only after acknowledgement, throw on failure. A future provider must use a
bounded network timeout and persistently deduplicate the supplied key.

The Mock provider deduplicates within its instance and supports injected failures.
Console logs are for pilot inspection, not delivery to customers. Database audits
prevent repeated successful runs from sending again. Across a crash after an external
provider accepts a message but before the database commits, exactly-once delivery
requires provider-side durable idempotency. Console output may repeat in that crash
window; it cannot act as a durable external delivery receipt.

## Configuration

Set server environment variables or `.env.local` for Next.js:

```dotenv
REMINDER_HOURS_BEFORE=24
NO_SHOW_GRACE_MINUTES=15
NO_SHOW_FOLLOWUP_HOURS=1
POST_SERVICE_FOLLOWUP_HOURS=24
AUTOMATION_INTERNAL_SECRET=<generate-a-random-server-only-secret>
```

Supply DATABASE_URL separately. No secret uses a NEXT_PUBLIC prefix.
Reminder config changes update unsent pending/failed reminders at the next cycle;
completed reminders are never sent again because of a config change. Restart the
server after changing its environment. Follow-up config applies when a job is created.
Post-service delay starts at the completion update timestamp. No-show delay starts
at detection. Overdue reminders are sent on the next cycle only while the appointment
is still in the future and confirmed.

## Local and scheduler use

Start Next.js with `npm run dev -- --hostname 127.0.0.1 --port 3000`.
Create a booking from the existing customer UI, then invoke:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/internal/automation/run -Headers @{ 'x-automation-secret' = $env:AUTOMATION_INTERNAL_SECRET }
```

Missing/wrong secret, or missing server configuration, returns 403.
The result includes detected no-shows and processed job statuses. Inspect the server
console and automation_jobs/automation_logs. Repeating the call does not repeat completed jobs.
For quick pilot reminders set REMINDER_HOURS_BEFORE to a suitable value and restart.
Reschedule or cancel in the existing manage page, then run another cycle and inspect jobs.

Alternatively, set DATABASE_URL and config in the shell and run `npm run automation:run`.
The CLI closes its database connection and exits nonzero for failed deliveries.
Schedule this command, or authenticated HTTP calls, approximately once per minute using
the hosting scheduler or OS task scheduler of your choice. No external scheduler is installed
or activated by this phase. The worker function has no hosting-vendor dependency.

## Verification and remaining decisions

Verified on 2026-09-06: 30 tests passed, zero failed/skipped, including three real
PostgreSQL integration scenarios. Production `npm run build` passed. Live HTTP smoke
on loopback verified 200 for the UI/services, 403 without the runner secret, exactly
one confirmation on create, zero jobs on the second runner call, and cancellation
notification after cancelling the smoke booking.

The current pilot is running at http://127.0.0.1:3000 with seeded schedules on
2026-09-10 in `salon_booking_os_phase4_pilot`, separate from `salon_booking_os_test`.
The loopback-only demo runner uses `dev-secret`; replace it before any shared deployment.
For this local demo, set `$env:AUTOMATION_INTERNAL_SECRET='dev-secret'` before the HTTP
command above. No scheduler has been activated, so invoke the runner explicitly.

Run `npm test` with TEST_DATABASE_URL pointing ONLY at a disposable PostgreSQL database:
integration tests reset its public schema. The suite covers ordinary booking regressions,
idempotent creation and reruns, scheduling, reschedule/cancel invalidation, no-show/history,
completion follow-up, provider failures, atomic rollback, concurrent claims, stale claim
recovery, check-in races, config changes and delivery/commit failure simulation.
Run `npm run build` separately from the development server.

Before real customer delivery: select a provider with durable idempotency or define an
explicit at-least-once delivery policy; add recipient resolution/message templates and
network timeouts; decide retry backoff/maximum attempts/alerting and production cadence.
Reconciliation scans up to 100 missing-job bookings per cycle; normal API paths enqueue
atomically. Completed/no-show follow-up keys currently allow one of each per booking.
LINE OA, real email/SMS, AI Receptionist and recurring weekly schedules are outside Phase 4.
