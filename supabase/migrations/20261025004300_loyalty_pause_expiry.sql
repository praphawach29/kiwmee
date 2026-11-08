-- Points do not run out while a plan has paused the loyalty programme (docs/BILLING_PLAN.md 5.6).
--
--   loyalty_programs.paused_at  when plan_sync() paused it
--   loyalty_pauses              one row per pause that ended: how long, how many lots moved (audit)
--   When the programme is switched back on (plan_sync after an upgrade, or the owner), every lot of
--   points that was still valid when the pause began has its expiry moved on by the length of the
--   pause. Points that had already run out stay out. Balances are worked out from expires_at
--   (loyalty_balance), so nothing else changes.

alter table public.loyalty_programs add column if not exists paused_at timestamptz;

create table if not exists public.loyalty_pauses (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  paused_at timestamptz not null,
  resumed_at timestamptz not null default now(),
  lots_moved int not null default 0
);
create index if not exists loyalty_pauses_brand_idx on public.loyalty_pauses(brand_id, resumed_at desc);
alter table public.loyalty_pauses enable row level security;
drop policy if exists loyalty_pauses_select on public.loyalty_pauses;
create policy loyalty_pauses_select on public.loyalty_pauses for select to authenticated using (public.is_brand_member(brand_id));
revoke all on public.loyalty_pauses from anon, authenticated;
grant select on public.loyalty_pauses to authenticated;
grant all on public.loyalty_pauses to service_role;

-- Switched back on after a pause: move the expiry of every lot still valid when the pause began
create or replace function public.loyalty_programs_resume()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lots int;
begin
  if new.active and not old.active and old.paused_at is not null then
    update public.loyalty_ledger
       set expires_at = expires_at + (now() - old.paused_at)
     where brand_id = new.brand_id and points > 0
       and expires_at is not null and expires_at > old.paused_at;
    get diagnostics v_lots = row_count;
    insert into public.loyalty_pauses (brand_id, paused_at, lots_moved) values (new.brand_id, old.paused_at, v_lots);
    new.paused_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists loyalty_programs_resume on public.loyalty_programs;
create trigger loyalty_programs_resume before update of active on public.loyalty_programs
  for each row execute function public.loyalty_programs_resume();

-- plan_sync() as in …004200, now noting when it paused the programme
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
    update public.loyalty_programs set active = false, paused_by_plan = true, paused_at = now() where brand_id = p_brand_id and active;
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

revoke execute on function public.loyalty_programs_resume() from public, anon, authenticated;
revoke execute on function public.plan_sync(uuid) from public, anon, authenticated;
grant execute on function public.plan_sync(uuid) to service_role;

-- programmes already paused before this migration: count their pause from now
update public.loyalty_programs set paused_at = now() where paused_by_plan and not active and paused_at is null;
