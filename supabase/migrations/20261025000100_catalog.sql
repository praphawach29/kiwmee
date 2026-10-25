-- Flexible booking v2, step 1 (docs/FLEXIBLE_BOOKING_DESIGN.md §4.2–4.5)
-- What a shop offers and when: resources (staff, chairs, rooms…), opening hours, offerings,
-- prices and the booking flow. Members read; only owners change it.

-- 1. Resources: anything a booking holds so nobody else can have it at that time
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('staff','court','room','equipment')),
  name text not null check (length(trim(name)) > 0),
  capacity int not null default 1 check (capacity >= 1),
  member_user_id uuid references auth.users(id) on delete set null,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);
create index resources_business_idx on public.resources(business_id, kind) where active;
create trigger resources_set_updated_at before update on public.resources
  for each row execute function public.set_updated_at();

-- 2. Opening hours and closures (were business_hours / business_closures, migration 008)
create table public.business_hours (
  business_id uuid not null references public.businesses(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),   -- 0 = Sunday
  is_open boolean not null default true,
  open_time time not null default '10:00',
  close_time time not null default '19:00',
  primary key (business_id, day_of_week),
  check (close_time > open_time)
);

create table public.business_closures (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  date date not null,
  is_full_day boolean not null default true,
  start_time time,
  end_time time,
  reason text,
  check (is_full_day or (start_time is not null and end_time is not null and end_time > start_time))
);
create index business_closures_lookup on public.business_closures(business_id, date);

-- 3. Resource schedules and time off (were staff_schedules / staff_time_off)
create table public.resource_schedules (
  business_id uuid not null,
  resource_id uuid not null,
  day_of_week int not null check (day_of_week between 0 and 6),
  is_working boolean not null default true,
  start_time time not null default '10:00',
  end_time time not null default '19:00',
  primary key (resource_id, day_of_week),
  foreign key (resource_id, business_id) references public.resources(id, business_id) on delete cascade,
  check (end_time > start_time)
);

create table public.resource_time_off (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  resource_id uuid not null,
  date date not null,
  is_full_day boolean not null default true,
  start_time time,
  end_time time,
  reason text,
  foreign key (resource_id, business_id) references public.resources(id, business_id) on delete cascade,
  check (is_full_day or (start_time is not null and end_time is not null and end_time > start_time))
);
create index resource_time_off_lookup on public.resource_time_off(resource_id, date);

-- 4. Shop-wide booking rules (was business_booking_settings)
create table public.business_booking_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  min_lead_minutes int not null default 15 check (min_lead_minutes >= 0),
  slot_interval_minutes int not null default 15 check (slot_interval_minutes > 0),
  max_advance_days int not null default 30 check (max_advance_days > 0),
  hold_minutes int not null default 10 check (hold_minutes > 0),
  updated_at timestamptz not null default now()
);
create trigger business_booking_settings_set_updated_at before update on public.business_booking_settings
  for each row execute function public.set_updated_at();

-- 5. Offerings (were services): duration, party size, and which resources they need
create table public.offerings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category text,
  name text not null check (length(trim(name)) > 0),
  description text,
  duration_mode text not null default 'fixed' check (duration_mode in ('fixed','customer_choice')),
  duration_minutes int check (duration_minutes > 0),
  min_minutes int, max_minutes int, step_minutes int,
  buffer_after_minutes int not null default 0 check (buffer_after_minutes >= 0),
  max_party_size int not null default 1 check (max_party_size >= 1),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  check (duration_mode <> 'fixed' or duration_minutes is not null),
  check (duration_mode <> 'customer_choice' or
         (min_minutes > 0 and max_minutes >= min_minutes and step_minutes > 0))
);
create index offerings_business_idx on public.offerings(business_id) where active;
create trigger offerings_set_updated_at before update on public.offerings
  for each row execute function public.set_updated_at();

create table public.offering_requirements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  offering_id uuid not null,
  kind text not null check (kind in ('staff','court','room','equipment')),
  customer_picks boolean not null default false,
  units_per_booking text not null default 'one' check (units_per_booking in ('one','party_size')),
  unique (offering_id, kind),
  foreign key (offering_id, business_id) references public.offerings(id, business_id) on delete cascade
);

-- Which resources can do an offering (was staff_services). Both sides must be the same shop.
create table public.offering_resources (
  business_id uuid not null,
  offering_id uuid not null,
  resource_id uuid not null,
  primary key (offering_id, resource_id),
  foreign key (offering_id, business_id) references public.offerings(id, business_id) on delete cascade,
  foreign key (resource_id, business_id) references public.resources(id, business_id) on delete cascade
);
create index offering_resources_resource_idx on public.offering_resources(resource_id);

-- 6. Prices. The most specific matching rule wins (highest priority); the booking keeps a snapshot.
create table public.price_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  offering_id uuid not null,
  unit text not null check (unit in ('per_booking','per_hour','per_person')),
  amount numeric(12,2) not null check (amount >= 0),
  days_of_week int[] check (days_of_week is null or days_of_week <@ array[0,1,2,3,4,5,6]),
  start_time time,
  end_time time,
  priority int not null default 0,
  foreign key (offering_id, business_id) references public.offerings(id, business_id) on delete cascade,
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or end_time > start_time)
);
create index price_rules_offering_idx on public.price_rules(offering_id);

-- 7. Booking flow (design §5, revised): the customer may start from any step in `entry`;
-- every step in `require` must be chosen before `then`. The order between them follows from
-- the start (date always before time).
create table public.booking_flows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category text,
  entry text[] not null default array['date','offering'],
  require text[] not null default array['offering','date','time'],
  optional text[] not null default array['resource'],
  "then" text[] not null default array['customer'],
  options jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, category),
  check (cardinality(entry) >= 1 and entry <@ array['date','offering','resource']),
  check (require @> array['date','time'] and require <@ array['offering','resource','date','time','duration','party']),
  check (optional <@ array['resource','duration','party']),
  check ("then" <@ array['customer','payment'] and 'customer' = any("then")),
  check (not (require && optional)),
  -- a starting step must be one the customer chooses anyway
  check (entry <@ (require || optional))
);
create trigger booking_flows_set_updated_at before update on public.booking_flows
  for each row execute function public.set_updated_at();

-- 8. RLS: members of the shop read, owners write
do $$
declare t text;
begin
  foreach t in array array[
    'resources','business_hours','business_closures','resource_schedules','resource_time_off',
    'business_booking_settings','offerings','offering_requirements','offering_resources',
    'price_rules','booking_flows'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_business_member(business_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_business_owner(business_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_business_owner(business_id))', t || '_delete', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
