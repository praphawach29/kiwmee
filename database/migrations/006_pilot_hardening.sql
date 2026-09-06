begin;
create table if not exists ai_sessions (
  id uuid primary key default gen_random_uuid(), owner_hash text not null,
  external_key_hash text unique, state jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null, version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
drop trigger if exists ai_sessions_set_updated_at on ai_sessions;
create trigger ai_sessions_set_updated_at before update on ai_sessions for each row execute function set_updated_at();
create index if not exists idx_ai_sessions_expiry on ai_sessions(expires_at);
create table if not exists rate_limits (
  key_hash text not null, window_start timestamptz not null,
  count integer not null default 1 check (count > 0), expires_at timestamptz not null,
  primary key (key_hash, window_start)
);
create index if not exists idx_rate_limits_expiry on rate_limits(expires_at);
create table if not exists handoff_requests (
  id uuid primary key default gen_random_uuid(), session_id uuid references ai_sessions(id) on delete set null,
  booking_id uuid references bookings(id) on delete set null, customer_channel text not null,
  destination text, reason text not null, status text not null default 'pending'
    check (status in ('pending','accepted','resolved')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
drop trigger if exists handoff_requests_set_updated_at on handoff_requests;
create trigger handoff_requests_set_updated_at before update on handoff_requests for each row execute function set_updated_at();
create unique index if not exists idx_handoff_one_open_per_session on handoff_requests(session_id)
where session_id is not null and status in ('pending','accepted');
create index if not exists idx_handoff_status_created on handoff_requests(status, created_at);
create table if not exists admin_session_revocations (
  session_id uuid primary key, expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table if not exists line_webhook_events (
  event_id text primary key, status text not null default 'processing' check (status in ('processing','completed','failed')),
  attempts integer not null default 1, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
drop trigger if exists line_webhook_events_set_updated_at on line_webhook_events;
create trigger line_webhook_events_set_updated_at before update on line_webhook_events for each row execute function set_updated_at();
alter table ai_sessions enable row level security;
alter table rate_limits enable row level security;
alter table handoff_requests enable row level security;
alter table admin_session_revocations enable row level security;
alter table line_webhook_events enable row level security;
commit;
