begin;

-- =============================================================================
-- Salon Booking OS v1 - Dormant Payment Schema (Phase A)
-- Prepared for Payment, Deposit, Slip Verification & Refunds
-- Completely dormant: zero impact on existing production booking flow
-- =============================================================================

-- 1. Safely expand bookings.status check constraint to include 'expired'
-- Note: 'expired' is intentionally excluded from the GiST double-booking exclusion constraint
-- and ACTIVE_BOOKING_STATUSES in the Availability Engine, so expired bookings automatically
-- free up stylist schedules immediately without double-booking contention.
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending','confirmed','checked_in','completed','cancelled','no_show','rescheduled','expired'));

-- 2. TABLE: payments
-- Note on allocation design:
-- `original_booking_id` represents the immutable origin booking and MUST NEVER be rewritten
-- during reschedules. The authoritative current booking allocation source of truth is
-- maintained in `payment_allocations`.
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  original_booking_id uuid not null references bookings(id) on delete restrict,
  payment_type text not null check (payment_type in ('no_payment', 'deposit_fixed', 'deposit_percentage', 'full_payment')),
  provider text not null check (provider in ('promptpay_qr', 'opn', 'stripe', 'manual_bank_transfer')),
  amount_due numeric(10, 2) not null check (amount_due >= 0),
  amount_paid numeric(10, 2) not null default 0 check (amount_paid >= 0),
  currency varchar(3) not null default 'THB' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in (
    'pending',
    'slip_received',
    'verifying',
    'paid',
    'manual_review',
    'verification_failed',
    'expired'
  )),
  provider_reference text,
  transaction_namespace text,
  transaction_reference text,
  idempotency_key text not null unique,
  expires_at timestamptz not null,
  verification_deadline timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists payments_set_updated_at on payments;
create trigger payments_set_updated_at before update on payments for each row execute function set_updated_at();

create index if not exists idx_payments_booking on payments(original_booking_id);
create index if not exists idx_payments_pending_expires on payments(status, expires_at)
  where status in ('pending', 'slip_received', 'verifying');
create unique index if not exists idx_payments_provider_txn
  on payments(transaction_namespace, transaction_reference)
  where transaction_reference is not null;

-- 3. TABLE: payment_allocations
-- Source of truth for current booking allocation.
-- When a booking is rescheduled, the existing active allocation is transitioned to 'released' / 'transferred'
-- and a new 'active' allocation is assigned to the new booking ID.
create table if not exists payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete restrict,
  booking_id uuid not null references bookings(id) on delete restrict,
  amount numeric(10, 2) not null check (amount > 0),
  allocation_type text not null check (allocation_type in (
    'initial',
    'reschedule_transfer',
    'refund_release',
    'manual_adjustment'
  )),
  status text not null default 'active' check (status in ('active', 'released', 'transferred', 'refunded')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  metadata jsonb,
  check (
    (status = 'active' and released_at is null) or
    (status in ('released', 'transferred', 'refunded') and released_at is not null)
  )
);

create index if not exists idx_allocations_active_booking on payment_allocations(booking_id) where status = 'active';
create index if not exists idx_allocations_payment on payment_allocations(payment_id);

-- 4. TABLE: payment_attempts
create table if not exists payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  attempt_type text not null check (attempt_type in ('slip_upload', 'gateway_callback', 'manual_review_action')),
  slip_object_reference text,
  slip_hash text,
  verification_provider text not null,
  provider_request_id text,
  provider_status text,
  normalized_result text not null check (normalized_result in (
    'success',
    'amount_mismatch',
    'overpaid',
    'receiver_mismatch',
    'duplicate',
    'provider_error',
    'invalid_slip'
  )),
  verified_amount numeric(10, 2),
  verified_receiver text,
  verified_sender text,
  verified_transaction_reference text,
  verified_transaction_at timestamptz,
  failure_reason_code text,
  created_at timestamptz not null default now()
);

create index if not exists idx_attempts_payment on payment_attempts(payment_id);
create index if not exists idx_attempts_hash on payment_attempts(slip_hash) where slip_hash is not null;

-- 5. TABLE: payment_events (Append-only audit ledger)
-- ARCHITECTURAL INVARIANT: This table is strictly append-only.
-- Application architecture, database rules, and future procedures must NEVER UPDATE or DELETE
-- rows in payment_events. All payment state transitions, verification attempts, actor identities,
-- and reason codes must be preserved immutably for audit and financial reconciliation.
create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  event_type text not null check (event_type in (
    'payment_created',
    'slip_received',
    'verification_started',
    'verification_succeeded',
    'verification_failed',
    'manual_review_requested',
    'payment_expired',
    'payment_confirmed',
    'allocation_transferred',
    'refund_requested',
    'refund_completed'
  )),
  from_status text,
  to_status text not null,
  actor text not null default 'system',
  reason_code text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_payment on payment_events(payment_id);

-- 6. TABLE: refunds
-- ARCHITECTURAL INVARIANT:
-- `refunds.amount` must be strictly positive (> 0).
-- The invariant `sum(completed_refunds) <= payments.amount_paid` is enforced transactionally
-- within the Payment Domain service (Phase B/C) rather than via asynchronous/fragile DB triggers.
create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete restrict,
  booking_id uuid not null references bookings(id) on delete restrict,
  amount numeric(10, 2) not null check (amount > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  idempotency_key text not null unique,
  provider text,
  provider_refund_id text,
  approved_by text not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists refunds_set_updated_at on refunds;
create trigger refunds_set_updated_at before update on refunds for each row execute function set_updated_at();

create index if not exists idx_refunds_payment on refunds(payment_id);

-- 7. TABLE: business_integrations (Credential References - NO plaintext secrets)
-- SECURITY REQUIREMENT:
-- NEVER store raw API keys, secret keys, webhook secrets, or private tokens in this table.
-- Only indirect credential references (e.g. encrypted vault key ID, KMS reference) are allowed in `credential_reference`.
create table if not exists business_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  integration_type text not null check (integration_type in ('payment_gateway', 'slip_verification', 'promptpay', 'line')),
  provider text not null,
  enabled boolean not null default false,
  merchant_account_id text,
  credential_reference text not null,
  public_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id, integration_type, provider)
);

drop trigger if exists business_integrations_set_updated_at on business_integrations;
create trigger business_integrations_set_updated_at before update on business_integrations for each row execute function set_updated_at();

-- 8. Enable Row Level Security (Strict Fail-Closed)
-- By enabling RLS without creating any public / anon permissive policies,
-- all external client requests (PostgREST / anon role) are blocked from accessing financial tables.
-- Only privileged backend database connections (service_role / server connections) can access these tables.
alter table payments enable row level security;
alter table payment_allocations enable row level security;
alter table payment_attempts enable row level security;
alter table payment_events enable row level security;
alter table refunds enable row level security;
alter table business_integrations enable row level security;

commit;
