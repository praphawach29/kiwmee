-- Points for LINE members (docs/LOYALTY_DESIGN.md §3–§5, step 6e, first release).
--
--   loyalty_programs     one per brand: how points are earned (per baht or per visit) and when they expire
--   loyalty_rewards      what points buy (a discount in baht), set by the brand's owner
--   loyalty_ledger       every point in and out, append-only (earn · redeem · release · reverse · adjust);
--                        the balance is worked out from it, oldest-expiring points used first
--   loyalty_member_codes a short-lived 6-digit code the member shows at the counter (walk-in sales)
--
-- Points are earned when a bill is CLOSED (paid), from what was actually paid after a reward discount,
-- rounded down, only on bills tied to a LINE member. A refund takes points back in proportion. A bill
-- uses at most one reward; voiding it gives the points back. The member is always the LINE user id
-- (the same person across the brand's branches).
-- Not yet: membership tiers, holding points while booking, expiry reminder cards (later steps).
-- Safe to run again.

create table if not exists public.loyalty_programs (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  active boolean not null default false,
  name text not null default 'คะแนนสะสม' check (length(trim(name)) between 1 and 60),
  earn_mode text not null default 'per_baht' check (earn_mode in ('per_baht', 'per_visit')),
  earn_per_baht numeric(12,2) check (earn_per_baht > 0),
  earn_points int not null default 1 check (earn_points between 1 and 100000),
  expire_months int check (expire_months between 1 and 120),        -- null = never
  updated_at timestamptz not null default now(),
  check (earn_mode <> 'per_baht' or earn_per_baht is not null)
);

create table if not exists public.loyalty_rewards (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  points_cost int not null check (points_cost between 1 and 10000000),
  discount_baht numeric(12,2) not null check (discount_baht > 0),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists loyalty_rewards_brand_idx on public.loyalty_rewards(brand_id);

create table if not exists public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  line_user_id text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  business_id uuid references public.businesses(id) on delete set null,
  bill_id uuid references public.bills(id) on delete set null,
  reward_id uuid references public.loyalty_rewards(id) on delete set null,
  kind text not null check (kind in ('earn', 'redeem', 'release', 'reverse', 'adjust')),
  points int not null check (points <> 0),
  expires_at timestamptz,                       -- points coming in (earn, release, adjust +)
  note text check (note is null or length(note) <= 200),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists loyalty_ledger_member_idx on public.loyalty_ledger(brand_id, line_user_id, created_at);
create index if not exists loyalty_ledger_bill_idx on public.loyalty_ledger(bill_id);

create table if not exists public.loyalty_member_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  brand_id uuid not null references public.brands(id) on delete cascade,
  line_user_id text not null,
  expires_at timestamptz not null
);

-- ---------- who sees and changes what ----------
alter table public.loyalty_programs enable row level security;
alter table public.loyalty_rewards enable row level security;
alter table public.loyalty_ledger enable row level security;
alter table public.loyalty_member_codes enable row level security;

drop policy if exists loyalty_programs_select on public.loyalty_programs;
create policy loyalty_programs_select on public.loyalty_programs for select to authenticated using (public.is_brand_member(brand_id));
drop policy if exists loyalty_rewards_select on public.loyalty_rewards;
create policy loyalty_rewards_select on public.loyalty_rewards for select to authenticated using (public.is_brand_member(brand_id));
drop policy if exists loyalty_rewards_owner_insert on public.loyalty_rewards;
create policy loyalty_rewards_owner_insert on public.loyalty_rewards for insert to authenticated with check (public.is_brand_owner(brand_id));
drop policy if exists loyalty_rewards_owner_update on public.loyalty_rewards;
create policy loyalty_rewards_owner_update on public.loyalty_rewards for update to authenticated
  using (public.is_brand_owner(brand_id)) with check (public.is_brand_owner(brand_id));
drop policy if exists loyalty_ledger_select on public.loyalty_ledger;
create policy loyalty_ledger_select on public.loyalty_ledger for select to authenticated using (public.is_brand_member(brand_id));

revoke all on public.loyalty_programs, public.loyalty_rewards, public.loyalty_ledger, public.loyalty_member_codes from anon;
revoke all on public.loyalty_programs, public.loyalty_rewards, public.loyalty_ledger, public.loyalty_member_codes from authenticated;
grant select on public.loyalty_programs, public.loyalty_ledger to authenticated;
grant select, insert, update on public.loyalty_rewards to authenticated;
grant all on public.loyalty_programs, public.loyalty_rewards, public.loyalty_ledger, public.loyalty_member_codes to service_role;

-- ---------- the balance: points in, minus points out, oldest-expiring points used first ----------
-- Goes through the member's ledger in order: points out are taken from the lots that expire soonest
-- (and only from lots not yet expired at that moment). What is left in lots that have not expired by
-- p_now is the balance. A refund after the points were spent can leave a debt the next points pay.
create or replace function public.loyalty_balance(p_brand_id uuid, p_line_user_id text, p_now timestamptz default now())
returns table (balance int, expiring int, expiring_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row record;
  v_exp timestamptz[] := '{}';
  v_rem int[] := '{}';
  v_debt int := 0;
  v_need int;
  v_pick int;
  v_take int;
  i int;
begin
  if auth.uid() is not null and not public.is_brand_member(p_brand_id) then
    raise exception 'not a member of this brand' using errcode = '42501';
  end if;
  for v_row in
    select l.points, l.expires_at, l.created_at from public.loyalty_ledger l
     where l.brand_id = p_brand_id and l.line_user_id = p_line_user_id
     order by l.created_at, l.id
  loop
    -- lots that ran out before this entry are gone
    for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
      if v_exp[i] is not null and v_exp[i] <= v_row.created_at then v_rem[i] := 0; end if;
    end loop;
    if v_row.points > 0 then
      v_take := least(v_debt, v_row.points);          -- a debt is paid first
      v_debt := v_debt - v_take;
      if v_row.points - v_take > 0 then
        v_exp := v_exp || v_row.expires_at;
        v_rem := v_rem || (v_row.points - v_take);
      end if;
    else
      v_need := -v_row.points;
      while v_need > 0 loop
        v_pick := null;
        for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
          if v_rem[i] > 0 and (v_pick is null
               or (v_exp[i] is not null and (v_exp[v_pick] is null or v_exp[i] < v_exp[v_pick]))) then
            v_pick := i;
          end if;
        end loop;
        exit when v_pick is null;
        v_take := least(v_need, v_rem[v_pick]);
        v_rem[v_pick] := v_rem[v_pick] - v_take;
        v_need := v_need - v_take;
      end loop;
      v_debt := v_debt + v_need;
    end if;
  end loop;

  balance := 0; expiring := 0; expiring_at := null;
  for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
    if v_exp[i] is null or v_exp[i] > p_now then
      balance := balance + v_rem[i];
      -- what runs out within 30 days
      if v_rem[i] > 0 and v_exp[i] is not null and v_exp[i] <= p_now + interval '30 days' then
        expiring := expiring + v_rem[i];
        expiring_at := least(coalesce(expiring_at, v_exp[i]), v_exp[i]);
      end if;
    end if;
  end loop;
  balance := balance - v_debt;
  return next;
end;
$$;

create or replace function public.loyalty_expiry(p_brand_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case when p.expire_months is null then null else now() + make_interval(months => p.expire_months) end
    from public.loyalty_programs p where p.brand_id = p_brand_id
$$;

-- ---------- the brand's owner sets the rules ----------
create or replace function public.loyalty_save_program(
  p_brand_id uuid, p_active boolean, p_name text, p_earn_mode text, p_earn_per_baht numeric, p_earn_points int, p_expire_months int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_brand_owner(p_brand_id) then
    raise exception 'only the brand owner sets points' using errcode = '42501';
  end if;
  insert into public.loyalty_programs (brand_id, active, name, earn_mode, earn_per_baht, earn_points, expire_months, updated_at)
  values (p_brand_id, p_active, coalesce(nullif(trim(p_name), ''), 'คะแนนสะสม'), p_earn_mode,
          case when p_earn_mode = 'per_baht' then p_earn_per_baht end, p_earn_points, p_expire_months, now())
  on conflict (brand_id) do update set active = excluded.active, name = excluded.name, earn_mode = excluded.earn_mode,
    earn_per_baht = excluded.earn_per_baht, earn_points = excluded.earn_points, expire_months = excluded.expire_months,
    updated_at = now();
end;
$$;

-- The owner gives or takes points by hand (a gift, a correction)
create or replace function public.loyalty_adjust(p_business_id uuid, p_line_user_id text, p_points int, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand uuid;
begin
  select brand_id into v_brand from public.businesses where id = p_business_id;
  if v_brand is null or not public.is_brand_owner(v_brand) then
    raise exception 'only the brand owner adjusts points' using errcode = '42501';
  end if;
  if p_points is null or p_points = 0 or abs(p_points) > 1000000 then
    raise exception using errcode = 'BK422', message = 'INVALID_POINTS';
  end if;
  insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, expires_at, note, created_by)
  values (v_brand, p_line_user_id, p_business_id, 'adjust', p_points,
          case when p_points > 0 then public.loyalty_expiry(v_brand) end, nullif(trim(p_note), ''), auth.uid());
end;
$$;

-- ---------- at the counter ----------
-- The member's code (shown on their LINE page) ties a walk-in bill to them
create or replace function public.loyalty_issue_code(p_brand_id uuid, p_line_user_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  delete from public.loyalty_member_codes where expires_at < now() or (brand_id = p_brand_id and line_user_id = p_line_user_id);
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.loyalty_member_codes (code, brand_id, line_user_id, expires_at)
      values (v_code, p_brand_id, p_line_user_id, now() + interval '10 minutes');
      return v_code;
    exception when unique_violation then
      -- taken by someone else right now: draw again
    end;
  end loop;
end;
$$;

-- The counter checks a code before the sale (who it is, how many points) without using it up
create or replace function public.loyalty_peek_code(p_business_id uuid, p_code text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member text;
begin
  perform public.booking_assert_access(p_business_id);
  select c.line_user_id into v_member from public.loyalty_member_codes c join public.businesses b on b.brand_id = c.brand_id
   where b.id = p_business_id and c.code = trim(p_code) and c.expires_at >= now();
  return v_member;
end;
$$;

create or replace function public.bill_attach_member(p_bill_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_brand uuid;
  v_member text;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if not found then raise exception using errcode = 'BK404', message = 'NOT_FOUND'; end if;
  perform public.booking_assert_access(v_bill.business_id);
  if v_bill.status <> 'open' then raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE'; end if;
  select brand_id into v_brand from public.businesses where id = v_bill.business_id;
  delete from public.loyalty_member_codes
   where code = trim(p_code) and brand_id = v_brand and expires_at >= now()
   returning line_user_id into v_member;
  if v_member is null then raise exception using errcode = 'BK422', message = 'MEMBER_CODE_INVALID'; end if;
  update public.bills set line_user_id = v_member where id = p_bill_id;
  return v_member;
end;
$$;

-- One reward on an open bill (p_reward_id null takes it off): the points are used at once and come
-- back if the reward is taken off or the bill voided
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

-- ---------- earn when paid, give back when voided, take back when refunded ----------
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
  v_used record;
begin
  if new.line_user_id is null or new.status = old.status then return new; end if;
  select brand_id into v_brand from public.businesses where id = new.business_id;

  if new.status = 'closed' then
    select * into v_program from public.loyalty_programs where brand_id = v_brand and active;
    if not found or exists (select 1 from public.loyalty_ledger where bill_id = new.id and kind = 'earn') then return new; end if;
    v_points := case when v_program.earn_mode = 'per_visit' then v_program.earn_points
                     else (floor(new.total / v_program.earn_per_baht) * v_program.earn_points)::int end;
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
drop trigger if exists bills_loyalty on public.bills;
create trigger bills_loyalty after update of status on public.bills
  for each row execute function public.loyalty_on_bill_change();

-- A refund takes the bill's points back in proportion (rounded down overall)
create or replace function public.loyalty_on_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_earned int;
  v_reversed int;
  v_refunded numeric;
  v_target int;
begin
  if new.kind <> 'refund' then return new; end if;
  select * into v_bill from public.bills where id = new.bill_id;
  select coalesce(sum(points), 0)::int into v_earned from public.loyalty_ledger where bill_id = new.bill_id and kind = 'earn';
  if v_earned <= 0 or v_bill.total <= 0 then return new; end if;
  select coalesce(-sum(points), 0)::int into v_reversed from public.loyalty_ledger where bill_id = new.bill_id and kind = 'reverse';
  select coalesce(sum(amount), 0) into v_refunded from public.bill_payments where bill_id = new.bill_id and kind = 'refund';
  v_target := least(floor(v_earned * least(v_refunded / v_bill.total, 1)), v_earned)::int;
  if v_target > v_reversed then
    insert into public.loyalty_ledger (brand_id, line_user_id, business_id, bill_id, kind, points, note)
    select b.brand_id, v_bill.line_user_id, v_bill.business_id, v_bill.id, 'reverse', -(v_target - v_reversed), 'คืนเงิน'
      from public.businesses b where b.id = v_bill.business_id;
  end if;
  return new;
end;
$$;
drop trigger if exists bill_payments_loyalty on public.bill_payments;
create trigger bill_payments_loyalty after insert on public.bill_payments
  for each row execute function public.loyalty_on_refund();

revoke execute on function public.loyalty_balance(uuid, text, timestamptz) from public, anon;
grant execute on function public.loyalty_balance(uuid, text, timestamptz) to authenticated, service_role;
revoke execute on function public.loyalty_expiry(uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_save_program(uuid, boolean, text, text, numeric, int, int) from public, anon;
revoke execute on function public.loyalty_adjust(uuid, text, int, text) from public, anon;
revoke execute on function public.loyalty_issue_code(uuid, text) from public, anon, authenticated;
revoke execute on function public.bill_attach_member(uuid, text) from public, anon;
revoke execute on function public.loyalty_peek_code(uuid, text) from public, anon;
revoke execute on function public.bill_use_reward(uuid, uuid) from public, anon;
revoke execute on function public.loyalty_on_bill_change() from public, anon, authenticated;
revoke execute on function public.loyalty_on_refund() from public, anon, authenticated;
