-- Brands and branches (docs/LOYALTY_DESIGN.md §2 and §8, step 6c). Each shop (businesses row) is a
-- branch of one brand. Points (step 6e) are shared across a brand's branches, and the brand's plan
-- decides which features it has. Every existing shop becomes a brand of its own, owned by the
-- shop's owners, so nothing changes for anyone until they add a branch.
--
--   brands          the brand (name)
--   brand_members   who owns the brand: adds branches, moves shops in, sets points rules (6e)
--   brand_plans     free / starter / pro / loyalty — set by Kiwmee (service role), read by members
--
-- Shop membership (business_members) is unchanged: brand owners are made owners of each branch
-- they add or move in. Errors: BK404 NOT_FOUND, BK422 PLAN_LIMIT / SAME_BRAND / NOT_OWNER.

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger brands_set_updated_at before update on public.brands
  for each row execute function public.set_updated_at();

create table public.brand_members (
  brand_id uuid not null references public.brands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (brand_id, user_id)
);
create index brand_members_user_idx on public.brand_members(user_id);

create table public.brand_plans (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','starter','pro','loyalty')),
  valid_until timestamptz,                      -- past this date the brand is back on free (its data stays)
  updated_at timestamptz not null default now()
);
create trigger brand_plans_set_updated_at before update on public.brand_plans
  for each row execute function public.set_updated_at();

alter table public.businesses add column brand_id uuid references public.brands(id);

-- Every existing shop becomes its own brand, owned by the shop's owners
do $$
declare
  v_shop record;
  v_brand uuid;
begin
  for v_shop in select id, name from public.businesses where brand_id is null loop
    insert into public.brands (name) values (v_shop.name) returning id into v_brand;
    insert into public.brand_plans (brand_id) values (v_brand);
    update public.businesses set brand_id = v_brand where id = v_shop.id;
    insert into public.brand_members (brand_id, user_id)
    select v_brand, m.user_id from public.business_members m where m.business_id = v_shop.id and m.role = 'owner';
  end loop;
end $$;
alter table public.businesses alter column brand_id set not null;
create index businesses_brand_idx on public.businesses(brand_id);

-- A shop inserted without a brand (seed data, the service role) gets a brand of its own
create or replace function public.businesses_default_brand()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.brand_id is null then
    insert into public.brands (name) values (new.name) returning id into new.brand_id;
    insert into public.brand_plans (brand_id) values (new.brand_id);
  end if;
  return new;
end;
$$;
create trigger businesses_default_brand before insert on public.businesses
  for each row execute function public.businesses_default_brand();

-- A shop's owners may edit its name and kind, never move it to another brand themselves
create or replace function public.businesses_guard_brand()
returns trigger
language plpgsql
as $$
begin
  if new.brand_id is distinct from old.brand_id and current_user in ('authenticated', 'anon') then
    raise exception 'move a shop with move_business_to_brand' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger businesses_guard_brand before update of brand_id on public.businesses
  for each row execute function public.businesses_guard_brand();

create or replace function public.is_brand_owner(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.brand_members where brand_id = p_brand_id and user_id = auth.uid());
$$;

-- Brand owners, and anyone working at one of its branches, can see the brand
create or replace function public.is_brand_member(p_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_brand_owner(p_brand_id) or exists (
    select 1 from public.businesses b join public.business_members m on m.business_id = b.id
     where b.brand_id = p_brand_id and m.user_id = auth.uid()
  );
$$;

-- The plan in force today (an expired plan counts as free)
create or replace function public.brand_plan(p_brand_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case when p.valid_until is null or p.valid_until > now() then p.plan else 'free' end
                     from public.brand_plans p where p.brand_id = p_brand_id), 'free');
$$;

-- How many branches a plan allows
create or replace function public.brand_branch_limit(p_plan text)
returns int
language sql
immutable
as $$
  select case when p_plan in ('pro','loyalty') then 50 else 1 end;
$$;

alter table public.brands enable row level security;
alter table public.brand_members enable row level security;
alter table public.brand_plans enable row level security;
create policy brands_select on public.brands for select to authenticated using (public.is_brand_member(id));
create policy brands_update on public.brands for update to authenticated
  using (public.is_brand_owner(id)) with check (public.is_brand_owner(id));
create policy brand_members_select on public.brand_members for select to authenticated using (public.is_brand_member(brand_id));
create policy brand_plans_select on public.brand_plans for select to authenticated using (public.is_brand_member(brand_id));

revoke all on public.brands, public.brand_members, public.brand_plans from anon;
revoke all on public.brands, public.brand_members, public.brand_plans from authenticated;
grant select, update (name) on public.brands to authenticated;
grant select on public.brand_members, public.brand_plans to authenticated;
grant all on public.brands, public.brand_members, public.brand_plans to service_role;

-- create_business (…000500) gains the brand: a new shop starts a new brand owned by its creator
drop function public.create_business(text, text, text);
create or replace function public.create_business(p_name text, p_slug text, p_kind text default 'salon')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_brand uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  insert into public.businesses (name, slug, kind) values (p_name, p_slug, p_kind) returning id, brand_id into v_id, v_brand;
  insert into public.brand_members (brand_id, user_id) values (v_brand, auth.uid());
  insert into public.business_members (business_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.business_booking_settings (business_id) values (v_id);
  insert into public.booking_flows (business_id) values (v_id);
  insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
  select v_id, d, true, '10:00', '19:00' from generate_series(0, 6) d;
  return v_id;
end;
$$;

-- Brand owners are owners of every branch
create or replace function public.brand_owners_join(p_brand_id uuid, p_business_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.business_members (business_id, user_id, role)
  select p_business_id, bm.user_id, 'owner' from public.brand_members bm where bm.brand_id = p_brand_id
  on conflict (business_id, user_id) do update set role = 'owner';
$$;

-- A new branch of the brand, set up like p_copy_from (one of its branches): booking rules, flow,
-- opening hours, services with their prices and requirements, and — when p_copy_resources — the
-- stylists/courts with their weekly schedules. Bookings, customers, bills and days off are not copied.
create or replace function public.add_branch(
  p_brand_id uuid,
  p_name text,
  p_slug text,
  p_copy_from uuid default null,
  p_copy_resources boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_src public.businesses;
  v_off record;
  v_new_off uuid;
  v_res record;
  v_new_res uuid;
  v_res_map jsonb := '{}'::jsonb;
  v_off_map jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not public.is_brand_owner(p_brand_id) then
    raise exception 'only the brand owner can add a branch' using errcode = '42501';
  end if;
  if not exists (select 1 from public.brands where id = p_brand_id) then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform 1 from public.brands where id = p_brand_id for update;   -- one branch at a time per brand
  if (select count(*) from public.businesses where brand_id = p_brand_id)
     >= public.brand_branch_limit(public.brand_plan(p_brand_id)) then
    raise exception using errcode = 'BK422', message = 'PLAN_LIMIT';
  end if;
  if p_copy_from is not null then
    select * into v_src from public.businesses where id = p_copy_from and brand_id = p_brand_id;
    if not found then
      raise exception using errcode = 'BK404', message = 'NOT_FOUND';
    end if;
  end if;

  insert into public.businesses (name, slug, kind, timezone, brand_id)
  values (p_name, p_slug, coalesce(v_src.kind, 'salon'), coalesce(v_src.timezone, 'Asia/Bangkok'), p_brand_id)
  returning id into v_id;
  perform public.brand_owners_join(p_brand_id, v_id);

  if v_src.id is null then
    insert into public.business_booking_settings (business_id) values (v_id);
    insert into public.booking_flows (business_id) values (v_id);
    insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
    select v_id, d, true, '10:00', '19:00' from generate_series(0, 6) d;
    return v_id;
  end if;

  insert into public.business_booking_settings (business_id, min_lead_minutes, slot_interval_minutes, max_advance_days,
                                                hold_minutes, customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours)
  select v_id, min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
         customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours
    from public.business_booking_settings where business_id = v_src.id;
  if not found then
    insert into public.business_booking_settings (business_id) values (v_id);
  end if;
  insert into public.booking_flows (business_id, category, entry, require, optional, "then", options)
  select v_id, category, entry, require, optional, "then", options from public.booking_flows where business_id = v_src.id;
  if not exists (select 1 from public.booking_flows where business_id = v_id) then
    insert into public.booking_flows (business_id) values (v_id);
  end if;
  insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
  select v_id, day_of_week, is_open, open_time, close_time from public.business_hours where business_id = v_src.id;

  for v_off in select * from public.offerings where business_id = v_src.id and active loop
    insert into public.offerings (business_id, category, name, description, duration_mode, duration_minutes, min_minutes,
                                  max_minutes, step_minutes, buffer_after_minutes, max_party_size, sort_order)
    values (v_id, v_off.category, v_off.name, v_off.description, v_off.duration_mode, v_off.duration_minutes, v_off.min_minutes,
            v_off.max_minutes, v_off.step_minutes, v_off.buffer_after_minutes, v_off.max_party_size, v_off.sort_order)
    returning id into v_new_off;
    v_off_map := v_off_map || jsonb_build_object(v_off.id::text, v_new_off);
    insert into public.offering_requirements (business_id, offering_id, kind, customer_picks, units_per_booking)
    select v_id, v_new_off, kind, customer_picks, units_per_booking from public.offering_requirements where offering_id = v_off.id;
    insert into public.price_rules (business_id, offering_id, unit, amount, days_of_week, start_time, end_time, priority)
    select v_id, v_new_off, unit, amount, days_of_week, start_time, end_time, priority from public.price_rules where offering_id = v_off.id;
  end loop;

  if p_copy_resources then
    for v_res in select * from public.resources where business_id = v_src.id and active loop
      insert into public.resources (business_id, kind, name, capacity, sort_order)
      values (v_id, v_res.kind, v_res.name, v_res.capacity, v_res.sort_order)
      returning id into v_new_res;
      v_res_map := v_res_map || jsonb_build_object(v_res.id::text, v_new_res);
      insert into public.resource_schedules (business_id, resource_id, day_of_week, is_working, start_time, end_time)
      select v_id, v_new_res, day_of_week, is_working, start_time, end_time from public.resource_schedules where resource_id = v_res.id;
    end loop;
    insert into public.offering_resources (business_id, offering_id, resource_id)
    select v_id, (v_off_map->>l.offering_id::text)::uuid, (v_res_map->>l.resource_id::text)::uuid
      from public.offering_resources l
     where l.business_id = v_src.id and v_off_map ? l.offering_id::text and v_res_map ? l.resource_id::text;
  end if;
  return v_id;
end;
$$;

-- Bring a shop the caller owns into one of the caller's brands (e.g. two shops opened before
-- brands existed). Its old brand goes away when no shop is left in it.
create or replace function public.move_business_to_brand(p_business_id uuid, p_brand_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid;
begin
  select brand_id into v_old from public.businesses where id = p_business_id for update;
  if not found or not exists (select 1 from public.brands where id = p_brand_id) then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if auth.uid() is not null and not (public.is_business_owner(p_business_id) and public.is_brand_owner(p_brand_id)) then
    raise exception using errcode = 'BK422', message = 'NOT_OWNER';
  end if;
  if v_old = p_brand_id then
    raise exception using errcode = 'BK422', message = 'SAME_BRAND';
  end if;
  perform 1 from public.brands where id = p_brand_id for update;
  if (select count(*) from public.businesses where brand_id = p_brand_id)
     >= public.brand_branch_limit(public.brand_plan(p_brand_id)) then
    raise exception using errcode = 'BK422', message = 'PLAN_LIMIT';
  end if;
  update public.businesses set brand_id = p_brand_id where id = p_business_id;
  perform public.brand_owners_join(p_brand_id, p_business_id);
  if not exists (select 1 from public.businesses where brand_id = v_old) then
    delete from public.brands where id = v_old;
  end if;
end;
$$;

revoke execute on function public.businesses_guard_brand() from public, anon, authenticated;
revoke execute on function public.businesses_default_brand() from public, anon, authenticated;
revoke execute on function public.brand_owners_join(uuid, uuid) from public, anon, authenticated;
grant execute on function public.brand_owners_join(uuid, uuid) to service_role;
revoke execute on function public.is_brand_owner(uuid) from public, anon;
revoke execute on function public.is_brand_member(uuid) from public, anon;
revoke execute on function public.brand_plan(uuid) from public, anon;
revoke execute on function public.brand_branch_limit(text) from public, anon;
revoke execute on function public.create_business(text, text, text) from public, anon;
revoke execute on function public.add_branch(uuid, text, text, uuid, boolean) from public, anon;
revoke execute on function public.move_business_to_brand(uuid, uuid) from public, anon;
grant execute on function public.is_brand_owner(uuid) to authenticated, service_role;
grant execute on function public.is_brand_member(uuid) to authenticated, service_role;
grant execute on function public.brand_plan(uuid) to authenticated, service_role;
grant execute on function public.brand_branch_limit(text) to authenticated, service_role;
grant execute on function public.create_business(text, text, text) to authenticated, service_role;
grant execute on function public.add_branch(uuid, text, text, uuid, boolean) to authenticated, service_role;
grant execute on function public.move_business_to_brand(uuid, uuid) to authenticated, service_role;
