-- B3 (docs/BILLING_PLAN.md): the database enforces what each package allows.
--
--   plan_limit(plan, key) / plan_has(plan, feature) — the package table, mirrored from
--     src/v2/plans.js (tests/plans.test.js + supabase/tests/plan-limits.test.js keep them equal)
--   brand_plans.complimentary — a plan Kiwmee gave for free: never auto-renewed from the wallet
--   every brand on the free plan today gets Pro free until 31 Jan 2570 (2027-01-31, Bangkok time)
--
--   Guards (BEFORE triggers, errcode BK422, message PLAN_*):
--     bookings        online bookings a month (the shop's own entries never count) · no online
--                     booking at all on the loyalty-only plan
--     resources       active staff / courts / rooms (equipment for add-ons does not count)
--     business_members / business_invites   people with dashboard access across the brand
--     addon_groups    add-ons need starter or pro
--     offerings       multi-day rentals need pro
--     resources       a place on the court map needs pro
--     loyalty_programs  switching points on needs pro or loyalty
--   Nothing already there is removed or cancelled: a guard only refuses adding or switching on.
--   Branches: brand_branch_limit() now reads the same table (pro / loyalty: 2).

-- ---------- the package table ----------

create or replace function public.plan_limit(p_plan text, p_key text)
returns int
language sql
immutable
as $$
  -- null = no limit
  select case p_key
    when 'bookings_per_month' then case p_plan when 'free' then 50 when 'loyalty' then 0 else null end
    when 'resources'          then case p_plan when 'free' then 2 when 'starter' then 5 else null end
    when 'members'            then case p_plan when 'free' then 1 when 'starter' then 3 when 'loyalty' then 3 else null end
    when 'branches'           then case p_plan when 'pro' then 2 when 'loyalty' then 2 else 1 end
    when 'messages'           then case p_plan when 'starter' then 900 when 'pro' then 4000 when 'loyalty' then 1200 else 100 end
    when 'slip_checks'        then case p_plan when 'starter' then 50 when 'pro' then 300 else 0 end
  end;
$$;

create or replace function public.plan_has(p_plan text, p_feature text)
returns boolean
language sql
immutable
as $$
  select case p_feature
    when 'online_booking' then p_plan <> 'loyalty'
    when 'reminders'      then p_plan in ('starter', 'pro')
    when 'addons'         then p_plan in ('starter', 'pro')
    when 'rentals'        then p_plan = 'pro'
    when 'layout'         then p_plan = 'pro'
    when 'loyalty'        then p_plan in ('pro', 'loyalty')
    when 'export'         then p_plan in ('pro', 'loyalty')
    else false
  end;
$$;

create or replace function public.brand_branch_limit(p_plan text)
returns int
language sql
immutable
as $$
  select coalesce(public.plan_limit(p_plan, 'branches'), 1000);
$$;

-- The plan of the brand a shop belongs to
create or replace function public.business_plan(p_business_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.brand_plan(b.brand_id) from public.businesses b where b.id = p_business_id;
$$;

-- Online bookings this Bangkok month across the brand (what bookings_per_month limits)
create or replace function public.brand_month_online_bookings(p_brand_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.bookings k join public.businesses b on b.id = k.business_id
   where b.brand_id = p_brand_id and k.source <> 'admin'
     and k.created_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
$$;

-- Can customers book this shop online right now? (the booking page asks before showing the flow)
create or replace function public.business_online_open(p_business_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_plan text;
  v_limit int;
begin
  select brand_id into v_brand from public.businesses where id = p_business_id;
  if v_brand is null then return false; end if;
  v_plan := public.brand_plan(v_brand);
  if not public.plan_has(v_plan, 'online_booking') then return false; end if;
  v_limit := public.plan_limit(v_plan, 'bookings_per_month');
  return v_limit is null or public.brand_month_online_bookings(v_brand) < v_limit;
end;
$$;

-- People with access to the brand's dashboards, plus open invites to someone not in yet
create or replace function public.brand_people(p_brand_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select (select count(distinct m.user_id)::int from public.business_members m
            join public.businesses b on b.id = m.business_id where b.brand_id = p_brand_id)
       + (select count(distinct i.email)::int from public.business_invites i
            join public.businesses b on b.id = i.business_id
           where b.brand_id = p_brand_id and i.accepted_at is null
             and not exists (select 1 from public.business_members m2
                               join public.businesses b2 on b2.id = m2.business_id
                               join auth.users u on u.id = m2.user_id
                              where b2.brand_id = p_brand_id and lower(u.email) = i.email));
$$;

-- ---------- complimentary plans and the launch offer ----------

alter table public.brand_plans add column if not exists complimentary boolean not null default false;

insert into public.brand_plans (brand_id) select id from public.brands on conflict (brand_id) do nothing;

-- Every brand that is on the free plan today (including an expired paid plan) uses Pro free until
-- the end of 31 Jan 2570, Bangkok time. Brands already paying keep what they bought.
update public.brand_plans
   set plan = 'pro', valid_until = timestamptz '2027-01-31 23:59:59+07', complimentary = true
 where public.brand_plan(brand_id) = 'free';

-- ---------- guards ----------

create or replace function public.plan_refuse(p_reason text)
returns void
language plpgsql
as $$
begin
  raise exception using errcode = 'BK422', message = p_reason;
end;
$$;

-- online bookings a month
create or replace function public.bookings_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_plan text;
  v_limit int;
begin
  if new.source = 'admin' then return new; end if;
  select brand_id into v_brand from public.businesses where id = new.business_id;
  v_plan := public.brand_plan(v_brand);
  if not public.plan_has(v_plan, 'online_booking') then perform public.plan_refuse('PLAN_ONLINE_OFF'); end if;
  v_limit := public.plan_limit(v_plan, 'bookings_per_month');
  if v_limit is not null then
    perform pg_advisory_xact_lock(hashtextextended('plan-bookings:' || v_brand::text, 0));
    if public.brand_month_online_bookings(v_brand) >= v_limit then perform public.plan_refuse('PLAN_BOOKINGS_FULL'); end if;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_plan_guard on public.bookings;
create trigger bookings_plan_guard before insert on public.bookings
  for each row execute function public.bookings_plan_guard();

-- active resources, and a place on the court map
create or replace function public.resources_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_plan text;
  v_limit int;
begin
  select brand_id into v_brand from public.businesses where id = new.business_id;
  v_plan := public.brand_plan(v_brand);
  if new.active and new.kind <> 'equipment'
     and (tg_op = 'INSERT' or not old.active or old.kind = 'equipment') then
    v_limit := public.plan_limit(v_plan, 'resources');
    if v_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended('plan-resources:' || v_brand::text, 0));
      if (select count(*) from public.resources r join public.businesses b on b.id = r.business_id
           where b.brand_id = v_brand and r.active and r.kind <> 'equipment' and r.id <> new.id) >= v_limit then
        perform public.plan_refuse('PLAN_RESOURCES');
      end if;
    end if;
  end if;
  if new.layout_row is not null and (tg_op = 'INSERT' or old.layout_row is null)
     and not public.plan_has(v_plan, 'layout') then
    perform public.plan_refuse('PLAN_FEATURE_LAYOUT');
  end if;
  return new;
end;
$$;
drop trigger if exists resources_plan_guard on public.resources;
create trigger resources_plan_guard before insert or update of active, kind, layout_row on public.resources
  for each row execute function public.resources_plan_guard();

-- people: an invite takes a seat when it is sent; accepting it later is not refused
create or replace function public.invites_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_limit int;
begin
  select brand_id into v_brand from public.businesses where id = new.business_id;
  v_limit := public.plan_limit(public.brand_plan(v_brand), 'members');
  if v_limit is null then return new; end if;
  -- someone already in the brand (another branch) takes no new seat
  if exists (select 1 from public.business_members m join public.businesses b on b.id = m.business_id
               join auth.users u on u.id = m.user_id
              where b.brand_id = v_brand and lower(u.email) = new.email) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plan-members:' || v_brand::text, 0));
  if public.brand_people(v_brand) >= v_limit then perform public.plan_refuse('PLAN_MEMBERS'); end if;
  return new;
end;
$$;
drop trigger if exists business_invites_plan_guard on public.business_invites;
create trigger business_invites_plan_guard before insert on public.business_invites
  for each row execute function public.invites_plan_guard();

create or replace function public.members_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_limit int;
  v_email text;
begin
  select brand_id into v_brand from public.businesses where id = new.business_id;
  v_limit := public.plan_limit(public.brand_plan(v_brand), 'members');
  if v_limit is null then return new; end if;
  -- already in the brand, or accepting an invite that took its seat when it was sent
  if exists (select 1 from public.business_members m join public.businesses b on b.id = m.business_id
              where b.brand_id = v_brand and m.user_id = new.user_id) then
    return new;
  end if;
  select lower(email) into v_email from auth.users where id = new.user_id;
  if exists (select 1 from public.business_invites i join public.businesses b on b.id = i.business_id
              where b.brand_id = v_brand and i.accepted_at is null and i.email = v_email) then
    return new;
  end if;
  -- the first person of a brand (its owner) always gets in
  if not exists (select 1 from public.business_members m join public.businesses b on b.id = m.business_id
                  where b.brand_id = v_brand) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plan-members:' || v_brand::text, 0));
  if public.brand_people(v_brand) >= v_limit then perform public.plan_refuse('PLAN_MEMBERS'); end if;
  return new;
end;
$$;
drop trigger if exists business_members_plan_guard on public.business_members;
create trigger business_members_plan_guard before insert on public.business_members
  for each row execute function public.members_plan_guard();

-- add-ons
create or replace function public.addon_groups_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active)
     and not public.plan_has(public.business_plan(new.business_id), 'addons') then
    perform public.plan_refuse('PLAN_FEATURE_ADDONS');
  end if;
  return new;
end;
$$;
drop trigger if exists addon_groups_plan_guard on public.addon_groups;
create trigger addon_groups_plan_guard before insert or update of active on public.addon_groups
  for each row execute function public.addon_groups_plan_guard();

-- multi-day rentals
create or replace function public.offerings_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.duration_mode = 'days' and new.active
     and (tg_op = 'INSERT' or old.duration_mode is distinct from 'days' or not old.active)
     and not public.plan_has(public.business_plan(new.business_id), 'rentals') then
    perform public.plan_refuse('PLAN_FEATURE_RENTALS');
  end if;
  return new;
end;
$$;
drop trigger if exists offerings_plan_guard on public.offerings;
create trigger offerings_plan_guard before insert or update of duration_mode, active on public.offerings
  for each row execute function public.offerings_plan_guard();

-- points, rewards and tiers
create or replace function public.loyalty_programs_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active)
     and not public.plan_has(public.brand_plan(new.brand_id), 'loyalty') then
    perform public.plan_refuse('PLAN_FEATURE_LOYALTY');
  end if;
  return new;
end;
$$;
drop trigger if exists loyalty_programs_plan_guard on public.loyalty_programs;
create trigger loyalty_programs_plan_guard before insert or update of active on public.loyalty_programs
  for each row execute function public.loyalty_programs_plan_guard();

-- ---------- grants ----------

revoke execute on function public.plan_refuse(text) from public, anon, authenticated;
revoke execute on function public.bookings_plan_guard() from public, anon, authenticated;
revoke execute on function public.resources_plan_guard() from public, anon, authenticated;
revoke execute on function public.invites_plan_guard() from public, anon, authenticated;
revoke execute on function public.members_plan_guard() from public, anon, authenticated;
revoke execute on function public.addon_groups_plan_guard() from public, anon, authenticated;
revoke execute on function public.offerings_plan_guard() from public, anon, authenticated;
revoke execute on function public.loyalty_programs_plan_guard() from public, anon, authenticated;
-- counts about a brand: not for anonymous callers (the server reads them on its own connection)
revoke execute on function public.brand_month_online_bookings(uuid) from public, anon;
revoke execute on function public.brand_people(uuid) from public, anon;
revoke execute on function public.business_plan(uuid) from public, anon;
grant execute on function public.brand_month_online_bookings(uuid) to authenticated, service_role;
grant execute on function public.brand_people(uuid) to authenticated, service_role;
grant execute on function public.business_plan(uuid) to authenticated, service_role;
grant execute on function public.business_online_open(uuid) to anon, authenticated, service_role;
