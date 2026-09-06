-- Additive migration for existing Phase 3 databases. Safe to reapply.
begin;
create table if not exists automation_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  automation_type text not null check (automation_type in (
    'booking_confirmation', 'appointment_reminder', 'booking_cancellation',
    'no_show_followup', 'post_service_followup'
  )),
  event_key text not null unique,
  scheduled_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists automation_jobs_set_updated_at on automation_jobs;
create trigger automation_jobs_set_updated_at before update on automation_jobs
for each row execute function set_updated_at();
create index if not exists idx_automation_jobs_due on automation_jobs(status, scheduled_at);
create index if not exists idx_automation_jobs_booking on automation_jobs(booking_id);
alter table automation_jobs enable row level security;
commit;
