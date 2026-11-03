-- Points used when booking online (docs/LOYALTY_DESIGN.md §5, step 6f).
--
-- A LINE member picks a reward on the booking page: its points are set aside at once (a 'hold' entry
-- in the ledger, tied to the booking, so the balance drops and the same points cannot be spent twice).
-- At the desk the bill uses that reward (the staff can change it); the held points come back first and
-- the reward is then taken as a normal 'redeem'. Cancelled, no-show, or a deposit hold that ran out:
-- the points come back ('release'). A sweep in the server's reminder loop catches holds whose booking
-- ran out without a status change. All checks run again in the database: programme on, reward active,
-- the member's tier, enough points, one reward per booking.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code. Safe to run again.

alter table public.loyalty_ledger add column if not exists booking_id uuid references public.bookings(id) on delete set null;
create index if not exists loyalty_ledger_booking_idx on public.loyalty_ledger(booking_id) where booking_id is not null;
alter table public.loyalty_ledger drop constraint if exists loyalty_ledger_kind_check;
alter table public.loyalty_ledger add constraint loyalty_ledger_kind_check check (kind in ('earn', 'hold', 'redeem', 'release', 'reverse', 'adjust'));

-- What a booking still holds: { reward_id, points } (points 0 = nothing held)
create or replace function public.loyalty_booking_hold(p_booking_id uuid)
returns table (reward_id uuid, points int)
language sql
stable
security definer
set search_path = public
as $$
  select (array_agg(l.reward_id order by l.created_at desc) filter (where l.kind = 'hold'))[1],
         coalesce(-sum(l.points), 0)::int
    from public.loyalty_ledger l
   where l.booking_id = p_booking_id and l.bill_id is null and l.kind in ('hold', 'release')
$$;

-- Give back what a booking holds (cancelled, no-show, ran out, or the bill takes over)
create or replace function public.loyalty_release_hold(p_booking_id uuid, p_note text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_held record;
  v_booking record;
begin
  select * into v_held from public.loyalty_booking_hold(p_booking_id);
  if coalesce(v_held.points, 0) <= 0 then return 0; end if;
  select b.business_id, s.brand_id, c.line_user_id into v_booking
    from public.bookings b join public.businesses s on s.id = b.business_id join public.customers c on c.id = b.customer_id
   where b.id = p_booking_id;
  insert into public.loyalty_ledger (brand_id, line_user_id, business_id, booking_id, reward_id, kind, points, expires_at, note)
  values (v_booking.brand_id, v_booking.line_user_id, v_booking.business_id, p_booking_id, v_held.reward_id, 'release', v_held.points,
          public.loyalty_expiry(v_booking.brand_id), left(p_note, 200));
  return v_held.points;
end;
$$;

-- Set points aside for a booking made in LINE (the server, inside the same statement as the booking)
create or replace function public.loyalty_hold_for_booking(p_booking_id uuid, p_reward_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking record;
  v_reward public.loyalty_rewards;
  v_balance int;
  v_rank int;
  v_total numeric;
begin
  select b.id, b.business_id, s.brand_id, c.line_user_id, coalesce((b.price_snapshot->>'total')::numeric, 0) as total into v_booking
    from public.bookings b join public.businesses s on s.id = b.business_id join public.customers c on c.id = b.customer_id
   where b.id = p_booking_id;
  if not found then raise exception using errcode = 'BK404', message = 'NOT_FOUND'; end if;
  if v_booking.line_user_id is null then raise exception using errcode = 'BK422', message = 'NOT_A_MEMBER'; end if;
  if (select points from public.loyalty_booking_hold(p_booking_id)) > 0 then raise exception using errcode = 'BK422', message = 'ALREADY_HELD'; end if;
  if not exists (select 1 from public.loyalty_programs where brand_id = v_booking.brand_id and active) then
    raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE';
  end if;
  select * into v_reward from public.loyalty_rewards where id = p_reward_id and brand_id = v_booking.brand_id and active;
  if not found then raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE'; end if;
  if v_reward.min_tier_rank > 0 then
    select t.rank into v_rank from public.loyalty_tier(v_booking.brand_id, v_booking.line_user_id) t;
    if coalesce(v_rank, 0) < v_reward.min_tier_rank then raise exception using errcode = 'BK422', message = 'TIER_TOO_LOW'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('loyalty:' || v_booking.brand_id::text || ':' || v_booking.line_user_id, 0));
  select balance into v_balance from public.loyalty_balance(v_booking.brand_id, v_booking.line_user_id);
  if v_balance < v_reward.points_cost then raise exception using errcode = 'BK422', message = 'NOT_ENOUGH_POINTS'; end if;
  insert into public.loyalty_ledger (brand_id, line_user_id, business_id, booking_id, reward_id, kind, points)
  values (v_booking.brand_id, v_booking.line_user_id, v_booking.business_id, p_booking_id, v_reward.id, 'hold', -v_reward.points_cost);
  return jsonb_build_object('reward_id', v_reward.id, 'name', v_reward.name, 'points', v_reward.points_cost,
                            'discount', least(v_reward.discount_baht, v_booking.total));
end;
$$;

-- Called off, not shown, or the deposit hold ran out: the points come back
create or replace function public.loyalty_on_booking_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status in ('cancelled', 'no_show', 'expired') then
    perform public.loyalty_release_hold(new.id, case new.status when 'cancelled' then 'ยกเลิกการจอง' when 'no_show' then 'ไม่มาตามนัด' else 'หมดเวลาโอนมัดจำ' end);
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_loyalty on public.bookings;
create trigger bookings_loyalty after update of status on public.bookings
  for each row execute function public.loyalty_on_booking_change();

-- The server's sweep: holds whose booking is over without a status change (a deposit hold that ran out)
create or replace function public.loyalty_release_stale_holds()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  for v_id in
    select distinct l.booking_id from public.loyalty_ledger l join public.bookings b on b.id = l.booking_id
     where l.kind = 'hold' and l.bill_id is null
       and (b.status in ('cancelled', 'no_show', 'expired') or (b.status = 'held' and b.hold_expires_at < now()))
  loop
    if public.loyalty_release_hold(v_id, 'หมดเวลาโอนมัดจำ') > 0 then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

-- ---------- the bill takes over what the booking held ----------
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

  -- points the customer set aside when booking: back first, then the reward chosen now is taken
  if v_bill.booking_id is not null then
    perform public.loyalty_release_hold(v_bill.booking_id, 'ใช้ตอนปิดบิล');
  end if;

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

-- ---------- a bill closed without choosing gives the held points back ----------
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
    -- points still set aside for this booking (no reward chosen at the desk) go back
    if new.booking_id is not null then perform public.loyalty_release_hold(new.booking_id, 'ปิดบิลโดยไม่ใช้รางวัล'); end if;
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

revoke execute on function public.loyalty_booking_hold(uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_release_hold(uuid, text) from public, anon, authenticated;
revoke execute on function public.loyalty_hold_for_booking(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.loyalty_release_stale_holds() from public, anon, authenticated;
revoke execute on function public.loyalty_on_booking_change() from public, anon, authenticated;
revoke execute on function public.bill_use_reward(uuid, uuid) from public, anon;
revoke execute on function public.loyalty_on_bill_change() from public, anon, authenticated;
