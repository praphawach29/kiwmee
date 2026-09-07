# Pilot Deployment Guide

This guide is for a single-business pilot with 1-3 salons. Multi-tenant SaaS, payments, loyalty, CRM, and advanced analytics are intentionally outside Phase 6.

## 1. Database

Use PostgreSQL or Supabase Postgres. For a fresh database, apply:

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

For an existing Phase 3-5 database, apply migrations in order:

```bash
psql "$DATABASE_URL" -f database/migrations/004_automation_jobs.sql
psql "$DATABASE_URL" -f database/migrations/005_automation_retry.sql
psql "$DATABASE_URL" -f database/migrations/006_pilot_hardening.sql
```

Keep `PGSSL=true` for Supabase production connections unless your platform terminates SSL elsewhere.

## 2. Environment

Start from `.env.example` and set real values. Required for pilot:

```env
DATABASE_URL=postgresql://...
PGSSL=true
PILOT_STRICT_CONFIG=true
BUSINESS_NAME=Your Salon
BUSINESS_TIMEZONE=Asia/Bangkok
BUSINESS_CONTACT=...
HANDOFF_DESTINATION=...
AUTOMATION_INTERNAL_SECRET=...
ADMIN_PASSWORD_HASH=...
ADMIN_SESSION_SECRET=...
AI_ENABLED=true
AI_PROVIDER=mock
LINE_ENABLED=false
AUTOMATION_DELIVERY_MODE=shadow
```

Generate `ADMIN_PASSWORD_HASH` locally:

```bash
ADMIN_PASSWORD_PLAIN='replace-with-long-password' npm run admin:hash-password
```

Use at least 32 random characters for `ADMIN_SESSION_SECRET` and `AUTOMATION_INTERNAL_SECRET`. Do not expose any secret in client code or frontend environment variables.

## 3. AI Provider

Pilot starts safely with the deterministic mock provider:

```env
AI_ENABLED=true
AI_PROVIDER=mock
```

To enable the real provider:

```env
AI_ENABLED=true
AI_PROVIDER=openai
OPENAI_API_KEY=...
AI_MODEL=gpt-5.4-mini
```

The real provider only selects a structured receptionist action. Booking writes still go through the existing Safe Tool Gateway and Booking Core.

## 4. LINE OA

Enable LINE after the HTTPS deployment URL is ready:

```env
LINE_ENABLED=true
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
```

In the LINE Developers console, set the webhook URL to:

```text
https://your-domain.example/api/line/webhook
```

The webhook verifies the LINE signature before processing. The LINE adapter reuses the same AI Receptionist service as the web assistant.

## 5. Worker And Scheduler

Keep the production worker in non-consuming shadow mode before LINE is enabled:

```env
AUTOMATION_DELIVERY_MODE=shadow
LINE_ENABLED=false
```

Shadow mode performs reconciliation and no-show lifecycle updates, but it does not
claim or complete notification jobs. This prevents console-only output from being
recorded as a successful customer delivery. Use `console` only for isolated canary
bookings. Set `live` only together with `LINE_ENABLED=true`; production validation
rejects live delivery without LINE credentials.

Run automation jobs from a scheduler, cron, platform job, or separate worker process:

```bash
npm run automation:run
```

For a simple hosted pilot, schedule either:

```bash
curl -X POST https://your-domain.example/api/internal/automation/run \
  -H "Authorization: Bearer $AUTOMATION_INTERNAL_SECRET"
```

or run `npm run automation:run` every 1-5 minutes in a worker. The runner processes due automation jobs and no-show detection one pass at a time. Jobs are idempotent and persisted in PostgreSQL.

For a long-running Railway worker, use `npm run automation:schedule` and configure:

```env
AUTOMATION_SCHEDULE_INTERVAL_MS=60000
AUTOMATION_MAX_CONSECUTIVE_FAILURES=5
```

The process exits non-zero after the configured number of consecutive failed cycles,
allowing Railway to restart it. Do not expose a public domain for the worker service.

## 6. Runtime Checks

Before deploy:

```bash
npm test
npm run build
npm run config:check
```

After deploy:

```bash
curl https://your-domain.example/api/health
```

Expected health response has `database: "ready"`. It includes business name and feature toggles but never secrets.

## 7. Operations

Use `/admin` for daily bookings, status updates, and handoff requests. Admin cookies expire and logout revokes the current session. Structured logs cover booking creation/conflicts, automation failures, AI tool invocations, handoffs, and LINE webhook failures; logs intentionally avoid API keys, full phone numbers, and unnecessary conversation text.

## 8. First-Shop Checklist

- Confirm services, staff, staff-service mappings, and availability data.
- Test customer booking, reschedule, cancel, and admin status updates against production data.
- Test automation runner with mock or console provider before enabling LINE push.
- Send a LINE test message and verify webhook signature handling.
- Keep `AI_PROVIDER=mock` for the first smoke test, then switch to `openai` once API credentials and spend limits are ready.
- Keep a human handoff destination monitored during business hours.
