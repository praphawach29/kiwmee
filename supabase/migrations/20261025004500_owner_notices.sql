-- B8 (docs/BILLING_PLAN.md 4, decision 6.5 = LINE): Kiwmee tells brand owners in LINE, through its
-- central Official Account, when their plan is about to end, when the wallet cannot renew it, when the
-- grace days start, and when the month's bookings / messages / slip checks pass 80% and 100%.
--
--   owner_line_links  one row per dashboard user: the LINE account notices go to. The owner opens a
--                     one-time link (a code shown in the dashboard, kept here only as a SHA-256 hash,
--                     15 minutes) inside LINE; LINE's ID token says who they are.
--   owner_notices     what was sent, one row per brand + notice, so a notice goes out once however
--                     often the server checks (claimed before it is sent, like booking_reminders).
-- Both only for the server's own connection: src/v2/owner-notices.js checks the signed-in person.

create table if not exists public.owner_line_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  line_user_id text check (line_user_id ~ '^U[0-9a-f]{32}$'),
  line_name text check (length(line_name) <= 120),
  linked_at timestamptz,
  code_hash text check (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists owner_line_links_code_idx on public.owner_line_links(code_hash) where code_hash is not null;
alter table public.owner_line_links enable row level security;
revoke all on public.owner_line_links from anon, authenticated;
grant all on public.owner_line_links to service_role;

create table if not exists public.owner_notices (
  brand_id uuid not null references public.brands(id) on delete cascade,
  kind text not null check (kind in ('expiring', 'grace', 'usage')),
  key text not null check (length(key) between 1 and 80),
  result text check (length(result) <= 40),
  created_at timestamptz not null default now(),
  primary key (brand_id, kind, key)
);
create index if not exists owner_notices_created_idx on public.owner_notices(created_at);
alter table public.owner_notices enable row level security;
revoke all on public.owner_notices from anon, authenticated;
grant all on public.owner_notices to service_role;
