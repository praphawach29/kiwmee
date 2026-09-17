-- Salon Booking OS v1 - Phase A1: Business Hours, Closures, Staff Schedules & Booking Settings
-- Additive migration for authoritative schedule sources and zero availability explanation

begin;

-- 1. TABLE: business_hours
-- Stores weekly recurring operating hours per day of week (0=Sunday .. 6=Saturday)
create table if not exists business_hours (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  day_of_week integer not null check (day_of_week between 0 and 6),
  is_open boolean not null default true,
  open_time time not null default '10:00',
  close_time time not null default '19:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, day_of_week),
  check (close_time > open_time)
);

drop trigger if exists business_hours_set_updated_at on business_hours;
create trigger business_hours_set_updated_at
  before update on business_hours
  for each row
  execute function set_updated_at();

create index if not exists idx_business_hours_lookup
  on business_hours(business_id, day_of_week);

-- 2. TABLE: business_closures
-- Stores one-off store holidays, special closures, or partial day closures
create table if not exists business_closures (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  date date not null,
  start_time time,
  end_time time,
  is_full_day boolean not null default false,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_full_day = true or (start_time is not null and end_time is not null and end_time > start_time))
);

drop trigger if exists business_closures_set_updated_at on business_closures;
create trigger business_closures_set_updated_at
  before update on business_closures
  for each row
  execute function set_updated_at();

create index if not exists idx_business_closures_date
  on business_closures(business_id, date);

-- 3. TABLE: staff_schedules
-- Stores weekly recurring working schedule per staff per day of week (0=Sunday .. 6=Saturday)
create table if not exists staff_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  staff_id uuid not null references staff(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null default '10:00',
  end_time time not null default '19:00',
  is_working boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, staff_id, day_of_week),
  check (end_time > start_time)
);

drop trigger if exists staff_schedules_set_updated_at on staff_schedules;
create trigger staff_schedules_set_updated_at
  before update on staff_schedules
  for each row
  execute function set_updated_at();

create index if not exists idx_staff_schedules_lookup
  on staff_schedules(business_id, staff_id, day_of_week);

-- 4. TABLE: staff_time_off
-- Stores staff leaves, vacations, or partial time off
create table if not exists staff_time_off (
  id uuid primary key default gen_random_uuid(),
  business_id text not null default 'default',
  staff_id uuid not null references staff(id) on delete cascade,
  date date not null,
  start_time time,
  end_time time,
  is_full_day boolean not null default true,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_full_day = true or (start_time is not null and end_time is not null and end_time > start_time))
);

drop trigger if exists staff_time_off_set_updated_at on staff_time_off;
create trigger staff_time_off_set_updated_at
  before update on staff_time_off
  for each row
  execute function set_updated_at();

create index if not exists idx_staff_time_off_lookup
  on staff_time_off(business_id, staff_id, date);

-- 5. TABLE: business_booking_settings
-- Stores business-level booking parameters
create table if not exists business_booking_settings (
  id uuid primary key default gen_random_uuid(),
  business_id text not null unique default 'default',
  booking_min_lead_minutes integer not null default 15 check (booking_min_lead_minutes >= 0),
  slot_interval_minutes integer not null default 15 check (slot_interval_minutes > 0),
  max_advance_booking_days integer not null default 30 check (max_advance_booking_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists business_booking_settings_set_updated_at on business_booking_settings;
create trigger business_booking_settings_set_updated_at
  before update on business_booking_settings
  for each row
  execute function set_updated_at();

-- 6. Initial Seeds for Pilot Tenant ('default')
-- Seed weekly business hours Mon-Sun 10:00 - 19:00
insert into business_hours (business_id, day_of_week, is_open, open_time, close_time)
values
  ('default', 0, true, '10:00', '19:00'),
  ('default', 1, true, '10:00', '19:00'),
  ('default', 2, true, '10:00', '19:00'),
  ('default', 3, true, '10:00', '19:00'),
  ('default', 4, true, '10:00', '19:00'),
  ('default', 5, true, '10:00', '19:00'),
  ('default', 6, true, '10:00', '19:00')
on conflict (business_id, day_of_week) do nothing;

-- Seed staff weekly schedules for all active staff (Mon-Sun 10:00 - 19:00)
insert into staff_schedules (business_id, staff_id, day_of_week, start_time, end_time, is_working)
select 'default', s.id, d.day, '10:00'::time, '19:00'::time, true
from staff s
cross join (values (0), (1), (2), (3), (4), (5), (6)) as d(day)
where s.active = true
on conflict (business_id, staff_id, day_of_week) do nothing;

-- Seed default booking settings
insert into business_booking_settings (business_id, booking_min_lead_minutes, slot_interval_minutes, max_advance_booking_days)
values ('default', 15, 15, 30)
on conflict (business_id) do nothing;

-- 7. Row Level Security (Fail-Closed)
alter table business_hours enable row level security;
alter table business_closures enable row level security;
alter table staff_schedules enable row level security;
alter table staff_time_off enable row level security;
alter table business_booking_settings enable row level security;

commit;
