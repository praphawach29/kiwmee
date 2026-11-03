-- Membership tiers (docs/LOYALTY_DESIGN.md §3.1, step 6e+).
--
--   loyalty_tiers   up to 5 per brand, rank 0 = where every member starts. A member reaches a tier when,
--                   within the programme's qualify_months, what they paid (closed bills, less refunds; a bill refunded in full is not a visit)
--                   reaches min_spend OR how many paid bills reaches min_visits (a threshold of 0 = not used).
--                   Tiers come from bills, not points: spending points never drops a tier.
--   earn_multiplier the tier's points bonus (Gold ×1.5): the tier held BEFORE the bill being paid.
--   card_theme      the card's look (classic · silver · gold · platinum · black) on the member's LINE page.
--   loyalty_rewards.min_tier_rank  a reward only from that tier up.
--
-- No row = no tiers (everyone has the same card). Tiers are saved together by loyalty_save_tiers
-- (brand owner only); members of the brand's shops read them; anon nothing.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code that reads these. Safe to run again.

create table if not exists public.loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  rank int not null check (rank between 0 and 4),
  name text not null check (length(trim(name)) between 1 and 30),
  min_spend numeric(12,2) not null default 0 check (min_spend between 0 and 100000000),
  min_visits int not null default 0 check (min_visits between 0 and 10000),
  earn_multiplier numeric(4,2) not null default 1 check (earn_multiplier between 1 and 5),
  card_theme text not null default 'classic' check (card_theme in ('classic', 'silver', 'gold', 'platinum', 'black')),
  benefits text[] not null default '{}' check (cardinality(benefits) <= 5),
  unique (brand_id, rank)
);

alter table public.loyalty_programs add column if not exists qualify_months int not null default 12;
alter table public.loyalty_programs drop constraint if exists loyalty_programs_qualify_months_check;
alter table public.loyalty_programs add constraint loyalty_programs_qualify_months_check check (qualify_months between 1 and 36);

alter table public.loyalty_rewards add column if not exists min_tier_rank int not null default 0;
alter table public.loyalty_rewards drop constraint if exists loyalty_rewards_min_tier_rank_check;
alter table public.loyalty_rewards add constraint loyalty_rewards_min_tier_rank_check check (min_tier_rank between 0 and 4);

-- ---------- who sees and changes what ----------
alter table public.loyalty_tiers enable row level security;
drop policy if exists loyalty_tiers_select on public.loyalty_tiers;
create policy loyalty_tiers_select on public.loyalty_tiers for select to authenticated using (public.is_brand_member(brand_id));
revoke all on public.loyalty_tiers from anon;
revoke all on public.loyalty_tiers from authenticated;
grant select on public.loyalty_tiers to authenticated;
grant all on public.loyalty_tiers to service_role;

-- ---------- a member's tier ----------
-- What they paid and how many paid bills within qualify_months, and the highest tier that reaches.
-- p_exclude_bill: leave one bill out (the tier held before that bill). rank null = the brand has no tiers.
create or replace function public.loyalty_tier(p_brand_id uuid, p_line_user_id text, p_now timestamptz default now(), p_exclude_bill uuid default null)
returns table (rank int, name text, earn_multiplier numeric, spend numeric, visits int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_months int;
  v_spend numeric;
  v_visits int;
begin
  if auth.uid() is not null and not public.is_brand_member(p_brand_id) then
    raise exception 'not a member of this brand' using errcode = '42501';
  end if;
  select coalesce(p.qualify_months, 12) into v_months from public.loyalty_programs p where p.brand_id = p_brand_id;
  v_months := coalesce(v_months, 12);
  -- a bill refunded in full is not a visit
  select coalesce(sum(greatest(n.net, 0)), 0), count(*) filter (where n.net > 0)::int
    into v_spend, v_visits
    from (select b.total - coalesce((select sum(x.amount) from public.bill_payments x where x.bill_id = b.id and x.kind = 'refund'), 0) as net
            from public.bills b join public.businesses s on s.id = b.business_id
           where s.brand_id = p_brand_id and b.line_user_id = p_line_user_id and b.status = 'closed'
             and b.closed_at > p_now - make_interval(months => v_months) and b.closed_at <= p_now
             and (p_exclude_bill is null or b.id <> p_exclude_bill)) n;
  v_spend := greatest(v_spend, 0);
  return query
    select t.rank, t.name, t.earn_multiplier, v_spend, v_visits
      from public.loyalty_tiers t
     where t.brand_id = p_brand_id
       and (t.rank = 0
            or (t.min_spend > 0 and v_spend >= t.min_spend)
            or (t.min_visits > 0 and v_visits >= t.min_visits))
     order by t.rank desc
     limit 1;
  if not found then
    return query select null::int, null::text, 1::numeric, v_spend, v_visits;
  end if;
end;
$$;

-- The owner saves every tier at once (p_tiers: [{ name, min_spend, min_visits, earn_multiplier, card_theme, benefits }],
-- rank = order in the list; [] = no tiers) and how many months count
create or replace function public.loyalty_save_tiers(p_brand_id uuid, p_qualify_months int, p_tiers jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier jsonb;
  v_rank int := 0;
begin
  if not public.is_brand_owner(p_brand_id) then
    raise exception 'only the brand owner sets tiers' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) > 5 then
    raise exception using errcode = 'BK422', message = 'INVALID_TIERS';
  end if;
  -- a programme row to hang the months on (switched off until the owner turns points on)
  insert into public.loyalty_programs (brand_id, earn_per_baht) values (p_brand_id, 100) on conflict (brand_id) do nothing;
  update public.loyalty_programs set qualify_months = p_qualify_months, updated_at = now() where brand_id = p_brand_id;
  delete from public.loyalty_tiers where brand_id = p_brand_id;
  for v_tier in select value from jsonb_array_elements(p_tiers) loop
    insert into public.loyalty_tiers (brand_id, rank, name, min_spend, min_visits, earn_multiplier, card_theme, benefits)
    values (p_brand_id, v_rank, trim(v_tier->>'name'),
            case when v_rank = 0 then 0 else coalesce((v_tier->>'min_spend')::numeric, 0) end,
            case when v_rank = 0 then 0 else coalesce((v_tier->>'min_visits')::int, 0) end,
            coalesce((v_tier->>'earn_multiplier')::numeric, 1),
            coalesce(v_tier->>'card_theme', 'classic'),
            coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(v_tier->'benefits', '[]'::jsonb)) x where trim(x) <> ''), '{}'));
    v_rank := v_rank + 1;
  end loop;
end;
$$;

-- ---------- rewards: only from their tier up ----------
create or replace function public.bill_use_reward(p_bill_id uuid, p_reward_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_brand uuid;
  v_reward public.loyalty_rewards;
  v_used record;
  v_balance int;
  v_rank int;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if not found then raise exception using errcode = 'BK404', message = 'NOT_FOUND'; end if;
  perform public.booking_assert_access(v_bill.business_id);
  if v_bill.status <> 'open' then raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE'; end if;
  select brand_id into v_brand from public.businesses where id = v_bill.business_id;

  -- give back a reward already on the bill
  select reward_id, sum(points)::int as points into v_used from public.loyalty_ledger
   where bill_id = p_bill_id and kind in ('redeem', 'release') group by reward_id having sum(points) <> 0;
  if v_used.points is not null then
    insert into public.loyalty_ledger (brand_id, line_user_id, business_id, bill_id, reward_id, kind, points, expires_at, created_by)
    values (v_brand, v_bill.line_user_id, v_bill.business_id, p_bill_id, v_used.reward_id, 'release', -v_used.points, public.loyalty_expiry(v_brand), auth.uid());
  end if;
  update public.bills set discount = 0, reward_id = null where id = p_bill_id;
  if p_reward_id is null then
    return public.bill_result(p_bill_id);
  end if;

  if v_bill.line_user_id is null then raise exception using errcode = 'BK422', message = 'NOT_A_MEMBER'; end if;
  select * into v_reward from public.loyalty_rewards where id = p_reward_id and brand_id = v_brand and active;
  if not found then raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE'; end if;
  if not exists (select 1 from public.loyalty_programs where brand_id = v_brand and active) then
    raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE';
  end if;
  if v_reward.min_tier_rank > 0 then
    select t.rank into v_rank from public.loyalty_tier(v_brand, v_bill.line_user_id) t;
    if coalesce(v_rank, 0) < v_reward.min_tier_rank then raise exception using errcode = 'BK422', message = 'TIER_TOO_LOW'; end if;
  end if;
  -- one member at a time: two counters cannot spend the same points
  perform pg_advisory_xact_lock(hashtextextended('loyalty:' || v_brand::text || ':' || v_bill.line_user_id, 0));
  select balance into v_balance from public.loyalty_balance(v_brand, v_bill.line_user_id);
  if v_balance < v_reward.points_cost then raise exception using errcode = 'BK422', message = 'NOT_ENOUGH_POINTS'; end if;
  insert into public.loyalty_ledger (brand_id, line_user_id, business_id, bill_id, reward_id, kind, points, created_by)
  values (v_brand, v_bill.line_user_id, v_bill.business_id, p_bill_id, v_reward.id, 'redeem', -v_reward.points_cost, auth.uid());
  update public.bills set discount = least(v_reward.discount_baht, subtotal), reward_id = v_reward.id where id = p_bill_id;
  return public.bill_result(p_bill_id);
end;
$$;

-- ---------- earn with the tier's bonus ----------
create or replace function public.loyalty_on_bill_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
  v_program public.loyalty_programs;
  v_points int;
  v_multiplier numeric;
  v_used record;
begin
  if new.line_user_id is null or new.status = old.status then return new; end if;
  select brand_id into v_brand from public.businesses where id = new.business_id;

  if new.status = 'closed' then
    select * into v_program from public.loyalty_programs where brand_id = v_brand and active;
    if not found or exists (select 1 from public.loyalty_ledger where bill_id = new.id and kind = 'earn') then return new; end if;
    -- the tier the member held before this bill
    select coalesce(t.earn_multiplier, 1) into v_multiplier from public.loyalty_tier(v_brand, new.line_user_id, now(), new.id) t;
    v_points := case when v_program.earn_mode = 'per_visit' then v_program.earn_points
                     else (floor(new.total / v_program.earn_per_baht) * v_program.earn_points)::int end;
    v_points := floor(v_points * coalesce(v_multiplier, 1))::int;
    if v_points > 0 then
      insert into public.loyalty_ledger (brand_id, line_user_id, business_id, bill_id, kind, points, expires_at)
      values (v_brand, new.line_user_id, new.business_id, new.id, 'earn', v_points,
              case when v_program.expire_months is null then null else now() + make_interval(months => v_program.expire_months) end);
    end if;
  elsif new.status = 'void' then
    select reward_id, sum(points)::int as points into v_used from public.loyalty_ledger
     where bill_id = new.id and kind in ('redeem', 'release') group by reward_id having sum(points) <> 0;
    if v_used.points is not null then
      insert into public.loyalty_ledger (brand_id, line_user_id, business_id, bill_id, reward_id, kind, points, expires_at)
      values (v_brand, new.line_user_id, new.business_id, new.id, v_used.reward_id, 'release', -v_used.points, public.loyalty_expiry(v_brand));
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.loyalty_tier(uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.loyalty_tier(uuid, text, timestamptz, uuid) to authenticated, service_role;
revoke execute on function public.loyalty_save_tiers(uuid, int, jsonb) from public, anon;
grant execute on function public.loyalty_save_tiers(uuid, int, jsonb) to authenticated, service_role;
revoke execute on function public.bill_use_reward(uuid, uuid) from public, anon;
revoke execute on function public.loyalty_on_bill_change() from public, anon, authenticated;
