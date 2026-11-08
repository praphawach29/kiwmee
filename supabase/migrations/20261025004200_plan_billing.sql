-- B4 (docs/BILLING_PLAN.md 5): how a brand's plan moves over time.
--
--   brand_plans  + cycle (month / year), auto_renew, next_plan + next_cycle (a cheaper plan or a
--                shorter cycle from the next renewal), trial (the 14-day trial), grace_until (7 more
--                days when the wallet could not pay the renewal)
--   brand_plan() a plan in its grace days still counts
--   plan_trials  one trial per person, ever: a new owner's first brand gets Pro for 14 days
--   paused_by_plan  on loyalty_programs, addon_groups, offerings, resources: what plan_sync() switched
--                off because the plan no longer includes it — and switches back on when it does again.
--                Nothing is deleted; bookings already made are untouched.

-- ---------- plan state ----------

alter table public.brand_plans
  add column if not exists cycle text not null default 'month' check (cycle in ('month', 'year')),
  add column if not exists auto_renew boolean not null default true,
  add column if not exists next_plan text check (next_plan in ('free', 'starter', 'pro', 'loyalty')),
  add column if not exists next_cycle text check (next_cycle in ('month', 'year')),
  add column if not exists trial boolean not null default false,
  add column if not exists grace_until timestamptz;

-- The plan in force today: an expired plan still counts during its grace days, then it is free
create or replace function public.brand_plan(p_brand_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case when p.valid_until is null or p.valid_until > now()
                                 or (p.grace_until is not null and p.grace_until > now())
                               then p.plan else 'free' end
                     from public.brand_plans p where p.brand_id = p_brand_id), 'free');
$$;

-- ---------- the 14-day trial ----------

create table if not exists public.plan_trials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  started_at timestamptz not null default now()
);
alter table public.plan_trials enable row level security;
revoke all on public.plan_trials from anon, authenticated;
grant all on public.plan_trials to service_role;

-- A person's first brand (made by create_business) gets Pro for 14 days, once per person ever
create or replace function public.start_trial(p_brand_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return false; end if;
  insert into public.plan_trials (user_id, brand_id) values (p_user_id, p_brand_id) on conflict (user_id) do nothing;
  if not found then return false; end if;
  update public.brand_plans
     set plan = 'pro', cycle = 'month', valid_until = now() + interval '14 days',
         complimentary = true, trial = true, auto_renew = false, grace_until = null, next_plan = null, next_cycle = null
   where brand_id = p_brand_id and public.brand_plan(brand_id) = 'free';
  return true;
end;
$$;

-- Everyone who already owns a brand has had their chance (the launch offer covers them)
insert into public.plan_trials (user_id, brand_id)
select distinct on (m.user_id) m.user_id, m.brand_id from public.brand_members m
 order by m.user_id, m.brand_id
on conflict (user_id) do nothing;

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
  perform public.start_trial(v_brand, auth.uid());   -- …004200: 14 days of Pro for a first brand
  return v_id;
end;
$$;

-- ---------- pausing what a plan no longer includes ----------

alter table public.loyalty_programs add column if not exists paused_by_plan boolean not null default false;
alter table public.addon_groups add column if not exists paused_by_plan boolean not null default false;
alter table public.offerings add column if not exists paused_by_plan boolean not null default false;
alter table public.resources add column if not exists paused_by_plan boolean not null default false;

-- Bring a brand's switched-on things in line with its plan: pause what the plan lacks, resume what
-- was paused once the plan includes it again. Safe to run any number of times.
create or replace function public.plan_sync(p_brand_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text := public.brand_plan(p_brand_id);
  v_limit int := public.plan_limit(v_plan, 'resources');
  v_active int;
  v_paused int := 0;
  v_resumed int := 0;
  v_n int;
begin
  -- points, rewards and tiers
  if public.plan_has(v_plan, 'loyalty') then
    update public.loyalty_programs set active = true, paused_by_plan = false where brand_id = p_brand_id and paused_by_plan;
    get diagnostics v_n = row_count; v_resumed := v_resumed + v_n;
  else
    update public.loyalty_programs set active = false, paused_by_plan = true where brand_id = p_brand_id and active;
    get diagnostics v_n = row_count; v_paused := v_paused + v_n;
  end if;

  -- add-ons
  if public.plan_has(v_plan, 'addons') then
    update public.addon_groups g set active = true, paused_by_plan = false
      from public.businesses b where b.id = g.business_id and b.brand_id = p_brand_id and g.paused_by_plan;
    get diagnostics v_n = row_count; v_resumed := v_resumed + v_n;
  else
    update public.addon_groups g set active = false, paused_by_plan = true
      from public.businesses b where b.id = g.business_id and b.brand_id = p_brand_id and g.active;
    get diagnostics v_n = row_count; v_paused := v_paused + v_n;
  end if;

  -- multi-day rentals
  if public.plan_has(v_plan, 'rentals') then
    update public.offerings o set active = true, paused_by_plan = false
      from public.businesses b where b.id = o.business_id and b.brand_id = p_brand_id and o.paused_by_plan;
    get diagnostics v_n = row_count; v_resumed := v_resumed + v_n;
  else
    update public.offerings o set active = false, paused_by_plan = true
      from public.businesses b where b.id = o.business_id and b.brand_id = p_brand_id and o.active and o.duration_mode = 'days';
    get diagnostics v_n = row_count; v_paused := v_paused + v_n;
  end if;

  -- staff / courts / rooms over the limit: the first ones (by the shop's order) stay on
  if v_limit is not null then
    update public.resources r set active = false, paused_by_plan = true
     where r.id in (
       select x.id from (
         select r2.id, row_number() over (order by r2.sort_order, r2.created_at, r2.id) as n
           from public.resources r2 join public.businesses b on b.id = r2.business_id
          where b.brand_id = p_brand_id and r2.active and r2.kind <> 'equipment'
       ) x where x.n > v_limit);
    get diagnostics v_n = row_count; v_paused := v_paused + v_n;
  end if;
  select count(*) into v_active from public.resources r join public.businesses b on b.id = r.business_id
   where b.brand_id = p_brand_id and r.active and r.kind <> 'equipment';
  update public.resources r set active = true, paused_by_plan = false
   where r.id in (
     select x.id from (
       select r2.id, row_number() over (order by r2.sort_order, r2.created_at, r2.id) as n
         from public.resources r2 join public.businesses b on b.id = r2.business_id
        where b.brand_id = p_brand_id and r2.paused_by_plan
     ) x where v_limit is null or x.n <= v_limit - v_active);
  get diagnostics v_n = row_count; v_resumed := v_resumed + v_n;

  return jsonb_build_object('plan', v_plan, 'paused', v_paused, 'resumed', v_resumed);
end;
$$;

-- Every brand whose switched-on things may not match its plan (the server runs this every hour)
create or replace function public.plan_sync_all()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_changed int := 0;
  v_result jsonb;
begin
  for v_brand in select id from public.brands loop
    v_result := public.plan_sync(v_brand);
    if (v_result->>'paused')::int + (v_result->>'resumed')::int > 0 then v_changed := v_changed + 1; end if;
  end loop;
  return v_changed;
end;
$$;

-- Whatever switches a row back on (plan_sync, or the owner once there is room) ends its pause
create or replace function public.clear_plan_pause()
returns trigger
language plpgsql
as $$
begin
  if new.active and not old.active then new.paused_by_plan := false; end if;
  return new;
end;
$$;
drop trigger if exists loyalty_programs_clear_pause on public.loyalty_programs;
create trigger loyalty_programs_clear_pause before update of active on public.loyalty_programs
  for each row execute function public.clear_plan_pause();
drop trigger if exists addon_groups_clear_pause on public.addon_groups;
create trigger addon_groups_clear_pause before update of active on public.addon_groups
  for each row execute function public.clear_plan_pause();
drop trigger if exists offerings_clear_pause on public.offerings;
create trigger offerings_clear_pause before update of active on public.offerings
  for each row execute function public.clear_plan_pause();
drop trigger if exists resources_clear_pause on public.resources;
create trigger resources_clear_pause before update of active on public.resources
  for each row execute function public.clear_plan_pause();

-- ---------- grants ----------

revoke execute on function public.start_trial(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.plan_sync(uuid) from public, anon, authenticated;
revoke execute on function public.plan_sync_all() from public, anon, authenticated;
revoke execute on function public.clear_plan_pause() from public, anon, authenticated;
grant execute on function public.start_trial(uuid, uuid) to service_role;
grant execute on function public.plan_sync(uuid) to service_role;
grant execute on function public.plan_sync_all() to service_role;
