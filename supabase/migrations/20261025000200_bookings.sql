-- Flexible booking v2, step 1 (docs/FLEXIBLE_BOOKING_DESIGN.md §4.6)
-- Customers, bookings, and the resources each booking holds. Double booking is refused by
-- the database itself for capacity-1 resources (exclusion constraint), as in the v1 schema.
-- Creating, moving and cancelling bookings will go through RPCs (step 3); until then members
-- can read, and only the service role writes.

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  phone text,
  email text,
  line_user_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);
create unique index customers_business_line_idx on public.customers(business_id, line_user_id) where line_user_id is not null;
create index customers_business_phone_idx on public.customers(business_id, phone);
create trigger customers_set_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  offering_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  party_size int not null default 1 check (party_size >= 1),
  status text not null default 'confirmed' check (status in
    ('held','pending','confirmed','checked_in','completed','cancelled','no_show','expired')),
  hold_expires_at timestamptz,
  price_snapshot jsonb not null default '{}'::jsonb,
  source text not null default 'web' check (source in ('web','liff','line_chat','admin')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (customer_id, business_id) references public.customers(id, business_id),
  foreign key (offering_id, business_id) references public.offerings(id, business_id),
  check (end_at > start_at),
  check ((status = 'held') = (hold_expires_at is not null))
);
create index bookings_business_start_idx on public.bookings(business_id, start_at);
create index bookings_customer_idx on public.bookings(customer_id);
create trigger bookings_set_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

create table public.booking_resources (
  business_id uuid not null,
  booking_id uuid not null,
  resource_id uuid not null,
  units int not null default 1 check (units >= 1),
  exclusive boolean not null default true,
  active boolean not null default true,
  range tstzrange not null,
  primary key (booking_id, resource_id),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade,
  foreign key (resource_id, business_id) references public.resources(id, business_id),
  check (not isempty(range) and lower_inc(range) and not upper_inc(range))
);
create index booking_resources_resource_range_idx on public.booking_resources using gist (resource_id, range) where active;

-- A capacity-1 resource can be held by one active booking at a time
alter table public.booking_resources add constraint booking_resources_no_overlap
  exclude using gist (resource_id with =, range with &&) where (exclusive and active);

-- exclusive comes from the resource, not from whoever writes the row
create or replace function public.booking_resources_set_exclusive()
returns trigger
language plpgsql
as $$
begin
  select r.capacity = 1 into new.exclusive from public.resources r where r.id = new.resource_id;
  return new;
end;
$$;
create trigger booking_resources_set_exclusive before insert or update of resource_id on public.booking_resources
  for each row execute function public.booking_resources_set_exclusive();

-- A booking that stops counting releases its resources
create or replace function public.bookings_release_resources()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('cancelled','no_show','expired') and old.status is distinct from new.status then
    update public.booking_resources set active = false where booking_id = new.id;
  end if;
  return new;
end;
$$;
create trigger bookings_release_resources after update of status on public.bookings
  for each row execute function public.bookings_release_resources();

create table public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  booking_id uuid not null,
  from_status text,
  to_status text not null,
  changed_by uuid,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade
);
create index booking_status_history_booking_idx on public.booking_status_history(booking_id);

-- RLS. Customers: members read and write (walk-ins, notes). Bookings and their resources and
-- history: members read; writes go through RPCs (step 3), so no write policies here.
alter table public.customers enable row level security;
create policy customers_select on public.customers for select to authenticated using (public.is_business_member(business_id));
create policy customers_insert on public.customers for insert to authenticated with check (public.is_business_member(business_id));
create policy customers_update on public.customers for update to authenticated
  using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));
create policy customers_delete on public.customers for delete to authenticated using (public.is_business_owner(business_id));

do $$
declare t text;
begin
  foreach t in array array['bookings','booking_resources','booking_status_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_business_member(business_id))', t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke all on public.customers from anon;
grant select, insert, update, delete on public.customers to authenticated;
grant all on public.customers to service_role;

-- Trigger functions are not meant to be called; keep them off the API
revoke execute on function public.booking_resources_set_exclusive() from public, anon, authenticated;
revoke execute on function public.bookings_release_resources() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
