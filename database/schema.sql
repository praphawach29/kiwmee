-- Salon Booking OS v1
-- PostgreSQL / Supabase compatible

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  line_user_id text,
  email text,
  contact_channel text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customers_set_updated_at
before update on customers
for each row
execute function set_updated_at();

create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  duration_minutes integer not null check (duration_minutes > 0),
  price numeric(12,2),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff_services (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  unique(staff_id, service_id)
);

create table availability (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  type text not null default 'available'
    check (type in ('available','blocked')),
  note text,
  check (end_at > start_at)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  service_id uuid not null references services(id),
  staff_id uuid not null references staff(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'confirmed'
    check (status in ('pending','confirmed','checked_in','completed','cancelled','no_show','rescheduled')),
  source text default 'web',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  booking_range tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored
);

alter table bookings
add constraint bookings_no_staff_overlap
exclude using gist (
  staff_id with =,
  booking_range with &&
)
where (status in ('pending','confirmed','checked_in','completed'));

create trigger bookings_set_updated_at
before update on bookings
for each row
execute function set_updated_at();

create table booking_status_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  changed_by text,
  changed_at timestamptz not null default now()
);

create table automation_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete set null,
  automation_name text not null,
  event_key text not null,
  result text not null,
  created_at timestamptz not null default now(),
  unique(event_key)
);

create table automation_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  automation_type text not null
    check (automation_type in (
      'booking_confirmation',
      'appointment_reminder',
      'booking_cancellation',
      'no_show_followup',
      'post_service_followup'
    )),
  event_key text not null unique,
  scheduled_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger automation_jobs_set_updated_at
before update on automation_jobs
for each row
execute function set_updated_at();

create index idx_bookings_staff_time on bookings(staff_id, start_at, end_at);
create index idx_bookings_customer on bookings(customer_id);
create index idx_bookings_status on bookings(status);
create index idx_availability_staff_time on availability(staff_id, start_at, end_at);
create index idx_automation_jobs_due on automation_jobs(status, scheduled_at);
create index idx_automation_jobs_booking on automation_jobs(booking_id);

alter table automation_jobs enable row level security;

create table ai_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_hash text not null,
  external_key_hash text unique,
  state jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ai_sessions_set_updated_at before update on ai_sessions
for each row execute function set_updated_at();
create index idx_ai_sessions_expiry on ai_sessions(expires_at);

create table rate_limits (
  key_hash text not null,
  window_start timestamptz not null,
  count integer not null default 1 check (count > 0),
  expires_at timestamptz not null,
  primary key (key_hash, window_start)
);
create index idx_rate_limits_expiry on rate_limits(expires_at);

create table handoff_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references ai_sessions(id) on delete set null,
  booking_id uuid references bookings(id) on delete set null,
  customer_channel text not null,
  destination text,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','accepted','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger handoff_requests_set_updated_at before update on handoff_requests
for each row execute function set_updated_at();
create unique index idx_handoff_one_open_per_session on handoff_requests(session_id)
where session_id is not null and status in ('pending','accepted');
create index idx_handoff_status_created on handoff_requests(status, created_at);

create table admin_session_revocations (
  session_id uuid primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table line_webhook_events (
  event_id text primary key,
  status text not null default 'processing' check (status in ('processing','completed','failed')),
  attempts integer not null default 1,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger line_webhook_events_set_updated_at before update on line_webhook_events
for each row execute function set_updated_at();

alter table ai_sessions enable row level security;
alter table rate_limits enable row level security;
alter table handoff_requests enable row level security;
alter table admin_session_revocations enable row level security;
alter table line_webhook_events enable row level security;

-- Double booking prevention should be enforced in transaction/application logic.
