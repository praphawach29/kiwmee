-- Add-ons (docs/FLEXIBLE_BOOKING_DESIGN.md §11, PR A): optional extras a customer may pick with an
-- offering — a racket to rent, a shower room, a longer treatment, a driver. Each add-on adds a price,
-- and may add minutes or hold one more resource of a kind for the booking's time.
--
--   addon_groups           "อุปกรณ์", "ประกันภัย": how many of its add-ons a customer may pick
--   offering_addon_groups  which offerings offer which groups (one group serves many offerings)
--   addons                 one extra, its price and what it uses
--   booking_addons         what a booking took, with the name and price copied at booking time
--   booking_resources.addon_id   a resource held because of an add-on (null = the offering's own)
--
-- This migration only stores the shop's settings; the booking page and create_booking start using
-- them in PR B. RLS as the catalog: members read, owners write, anon nothing. booking_addons is
-- written by the booking RPCs only (PR B).

create table public.addon_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  min_select int not null default 0 check (min_select between 0 and 50),
  max_select int check (max_select between 1 and 50),       -- null = no limit
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  check (max_select is null or max_select >= min_select)
);
create index addon_groups_business_idx on public.addon_groups(business_id);
create trigger addon_groups_set_updated_at before update on public.addon_groups
  for each row execute function public.set_updated_at();

create table public.offering_addon_groups (
  business_id uuid not null,
  offering_id uuid not null,
  group_id uuid not null,
  primary key (offering_id, group_id),
  foreign key (offering_id, business_id) references public.offerings(id, business_id) on delete cascade,
  foreign key (group_id, business_id) references public.addon_groups(id, business_id) on delete cascade
);
create index offering_addon_groups_group_idx on public.offering_addon_groups(group_id);

create table public.addons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  group_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  media jsonb not null default '[]'::jsonb check (public.valid_catalog_media(media)),
  price_unit text not null default 'per_booking'
    check (price_unit in ('per_booking','per_hour','per_day','per_person','per_unit')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  max_quantity int not null default 1 check (max_quantity between 1 and 1000),
  adds_minutes int not null default 0 check (adds_minutes between 0 and 720),
  uses_kind text check (uses_kind is null or length(trim(uses_kind)) between 1 and 40),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (group_id, business_id) references public.addon_groups(id, business_id) on delete cascade
);
create index addons_group_idx on public.addons(group_id);
create trigger addons_set_updated_at before update on public.addons
  for each row execute function public.set_updated_at();

-- No cascade from addons: an add-on a booking took is switched off, not deleted
create table public.booking_addons (
  business_id uuid not null,
  booking_id uuid not null,
  addon_id uuid not null,
  quantity int not null default 1 check (quantity >= 1),
  name text not null,
  total numeric(12,2) not null check (total >= 0),
  primary key (booking_id, addon_id),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade,
  foreign key (addon_id, business_id) references public.addons(id, business_id)
);
create index booking_addons_addon_idx on public.booking_addons(addon_id);

alter table public.booking_resources add column addon_id uuid;
alter table public.booking_resources
  add constraint booking_resources_addon_fk foreign key (addon_id, business_id) references public.addons(id, business_id);

-- RLS: members of the shop read, owners write (as the catalog, …000100)
do $$
declare t text;
begin
  foreach t in array array['addon_groups','offering_addon_groups','addons'] loop
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

-- booking_addons: members read; written only by the booking RPCs (security definer)
alter table public.booking_addons enable row level security;
create policy booking_addons_select on public.booking_addons for select to authenticated using (public.is_business_member(business_id));
revoke all on public.booking_addons from anon;
revoke insert, update, delete, truncate on public.booking_addons from authenticated;
grant select on public.booking_addons to authenticated;
grant all on public.booking_addons to service_role;
