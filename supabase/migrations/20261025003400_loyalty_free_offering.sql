-- Rewards that are a service for free ("ตัดผมฟรี 1 ครั้ง"), beside money off (docs/LOYALTY_DESIGN.md §5, free_offering).
--
--   loyalty_rewards.kind         discount (money off, discount_baht) · free_offering (offering_id, for free)
--   loyalty_reward_value(...)    what a reward takes off a bill: money off up to the subtotal, or — for a
--                                free service — that service's price (not its extras), up to the subtotal.
--                                A free service fits a booking of that service, or of the service with the
--                                same name at another branch of the brand; otherwise REWARD_NOT_FOR_THIS.
--                                At a walk-in sale (no booking) the desk decides; the value is the service's price.
-- The points rules (balance, tier, hold when booking, give back) are unchanged.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code. Safe to run again.

alter table public.loyalty_rewards add column if not exists kind text not null default 'discount';
alter table public.loyalty_rewards drop constraint if exists loyalty_rewards_kind_check;
alter table public.loyalty_rewards add constraint loyalty_rewards_kind_check check (kind in ('discount', 'free_offering'));
alter table public.loyalty_rewards add column if not exists offering_id uuid references public.offerings(id) on delete set null;
alter table public.loyalty_rewards alter column discount_baht drop not null;
alter table public.loyalty_rewards drop constraint if exists loyalty_rewards_discount_baht_check;
alter table public.loyalty_rewards drop constraint if exists loyalty_rewards_value_check;
alter table public.loyalty_rewards add constraint loyalty_rewards_value_check check (
  (kind = 'discount' and discount_baht > 0) or (kind = 'free_offering' and (discount_baht is null or discount_baht > 0))
);

-- a free service must be one of the brand's own (its shops'), and must be set when the reward is made
create or replace function public.loyalty_rewards_check_offering()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'free_offering' then
    if new.offering_id is null and (tg_op = 'INSERT' or old.offering_id is null) then
      raise exception using errcode = 'BK422', message = 'OFFERING_REQUIRED';
    end if;
    if new.offering_id is not null and not exists (
      select 1 from public.offerings o join public.businesses s on s.id = o.business_id
       where o.id = new.offering_id and s.brand_id = new.brand_id
    ) then
      raise exception using errcode = 'BK422', message = 'OFFERING_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists loyalty_rewards_offering on public.loyalty_rewards;
create trigger loyalty_rewards_offering before insert or update on public.loyalty_rewards
  for each row execute function public.loyalty_rewards_check_offering();

-- What the reward takes off: p_booking_id null = a walk-in sale
create or replace function public.loyalty_reward_value(p_reward_id uuid, p_business_id uuid, p_booking_id uuid, p_subtotal numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reward public.loyalty_rewards;
  v_booking record;
  v_name text;
  v_value numeric;
begin
  if auth.uid() is not null and not public.is_business_member(p_business_id) then
    raise exception 'not a member of this shop' using errcode = '42501';
  end if;
  select * into v_reward from public.loyalty_rewards where id = p_reward_id;
  if not found then raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE'; end if;
  if v_reward.kind = 'discount' then
    return greatest(least(v_reward.discount_baht, coalesce(p_subtotal, v_reward.discount_baht)), 0);
  end if;
  if v_reward.offering_id is null then raise exception using errcode = 'BK422', message = 'REWARD_UNAVAILABLE'; end if;
  select name into v_name from public.offerings where id = v_reward.offering_id;
  if p_booking_id is not null then
    select b.offering_id, o.name, b.price_snapshot into v_booking
      from public.bookings b join public.offerings o on o.id = b.offering_id
     where b.id = p_booking_id and b.business_id = p_business_id;
    if v_booking.offering_id is distinct from v_reward.offering_id and lower(trim(v_booking.name)) is distinct from lower(trim(v_name)) then
      raise exception using errcode = 'BK422', message = 'REWARD_NOT_FOR_THIS';
    end if;
    -- the service's own line (extras are paid), or the whole booking for an older one without lines
    select coalesce((select (l->>'total')::numeric from jsonb_array_elements(coalesce(v_booking.price_snapshot->'lines', '[]'::jsonb)) l where l->>'kind' = 'offering' limit 1),
                    (v_booking.price_snapshot->>'total')::numeric, 0)
      into v_value;
  else
    select coalesce((select p.amount from public.price_rules p where p.offering_id = v_reward.offering_id order by p.amount limit 1), 0) into v_value;
  end if;
  -- an owner may cap what a free service is worth
  if v_reward.discount_baht is not null then v_value := least(v_value, v_reward.discount_baht); end if;
  return greatest(least(v_value, coalesce(p_subtotal, v_value)), 0);
end;
$$;

-- ---------- holding points when booking: the value of a free service ----------
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
  v_value numeric;
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
  -- a free service fits only a booking of that service (raises REWARD_NOT_FOR_THIS)
  v_value := public.loyalty_reward_value(v_reward.id, v_booking.business_id, p_booking_id, v_booking.total);
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
                            'discount', v_value);
end;
$$;

-- ---------- the bill: the value of a free service ----------
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
  -- a free service fits only that service (checked before any points move)
  perform public.loyalty_reward_value(v_reward.id, v_bill.business_id, v_bill.booking_id, v_bill.subtotal);
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
  update public.bills set discount = public.loyalty_reward_value(v_reward.id, v_bill.business_id, v_bill.booking_id, subtotal), reward_id = v_reward.id where id = p_bill_id;
  return public.bill_result(p_bill_id);
end;
$$;

revoke execute on function public.loyalty_reward_value(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.loyalty_reward_value(uuid, uuid, uuid, numeric) to authenticated, service_role;
revoke execute on function public.loyalty_rewards_check_offering() from public, anon, authenticated;
revoke execute on function public.loyalty_hold_for_booking(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.bill_use_reward(uuid, uuid) from public, anon;
