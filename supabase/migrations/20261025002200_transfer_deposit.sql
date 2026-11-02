-- Transfer deposits (docs/FLEXIBLE_BOOKING_DESIGN.md §11.9 / §11.10 M): a shop may ask for a deposit
-- by bank transfer before a booking counts. The booking is held while the customer transfers; the
-- customer sends the slip from the booking page or their link; the shop looks at it and confirms.
-- No automatic slip checking yet.
--
--   business_booking_settings.deposit_mode / deposit_value   none · fixed (baht) · percent · full
--   business_booking_settings.payment_info                   where to transfer (shown to customers)
--   bookings.deposit_due        fixed when the booking is made (later setting changes do not move it)
--   payment_slips               the slip images (re-encoded WebP, ≤ 1.5 MB), members read, nobody
--                               writes them but customer_submit_slip
--   customer_submit_slip        held → pending (no more expiry: the shop decides), up to 5 slips
--   confirm_deposit             held/pending → confirmed, and the deposit goes on the booking's bill
--
-- The booking page holds a booking when deposit_mode is not 'none' (or the flow lists 'payment').
-- Errors: BK404 NOT_FOUND · BK409 HOLD_EXPIRED · BK422 NOT_CHANGEABLE, TOO_MANY_SLIPS, INVALID_AMOUNT.

alter table public.business_booking_settings
  add column deposit_mode text not null default 'none' check (deposit_mode in ('none','fixed','percent','full')),
  add column deposit_value numeric(12,2) not null default 0 check (deposit_value >= 0),
  add column payment_info jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payment_info) = 'object' and length(payment_info::text) <= 2000),
  add constraint business_booking_settings_deposit_check check (
    deposit_mode in ('none','full')
    or (deposit_mode = 'fixed' and deposit_value > 0)
    or (deposit_mode = 'percent' and deposit_value > 0 and deposit_value <= 100)
  );

alter table public.bookings add column deposit_due numeric(12,2) check (deposit_due >= 0);

create table public.payment_slips (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  booking_id uuid not null,
  image bytea not null check (octet_length(image) between 1 and 1572864),
  mime text not null default 'image/webp' check (mime = 'image/webp'),
  created_at timestamptz not null default now(),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade
);
create index payment_slips_booking_idx on public.payment_slips(booking_id, created_at desc);

alter table public.payment_slips enable row level security;
create policy payment_slips_select on public.payment_slips for select to authenticated using (public.is_business_member(business_id));
revoke all on public.payment_slips from anon;
revoke insert, update, delete, truncate on public.payment_slips from authenticated;
grant select on public.payment_slips to authenticated;
grant all on public.payment_slips to service_role;

-- What a booking of this price owes up front, by the shop's setting (whole baht for a percentage)
create or replace function public.booking_deposit_due(p_business_id uuid, p_total numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case s.deposit_mode
             when 'fixed' then case when coalesce(p_total, 0) > 0 then least(s.deposit_value, p_total) else s.deposit_value end
             when 'percent' then round(coalesce(p_total, 0) * s.deposit_value / 100)
             when 'full' then coalesce(p_total, 0)
             else 0 end
      from public.business_booking_settings s where s.business_id = p_business_id), 0);
$$;

create or replace function public.create_booking(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_customer jsonb,
  p_resource_id uuid default null,
  p_duration_minutes int default null,
  p_party_size int default 1,
  p_hold boolean default false,
  p_source text default 'web',
  p_notes text default null,
  p_addons jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan jsonb;
  v_customer uuid;
  v_name text := nullif(trim(p_customer->>'name'), '');
  v_phone text := nullif(trim(p_customer->>'phone'), '');
  v_line text := nullif(trim(p_customer->>'line_user_id'), '');
  v_hold_minutes int;
  v_id uuid;
begin
  perform public.booking_assert_access(p_business_id);
  if v_name is null then
    raise exception using errcode = 'BK422', message = 'CUSTOMER_NAME_REQUIRED';
  end if;
  perform public.expire_holds(p_business_id);
  v_plan := public.booking_plan(p_business_id, p_offering_id, p_start_at, p_resource_id, p_duration_minutes,
                                coalesce(p_party_size, 1), null, p_source = 'admin', false,
                                p_addons, case when p_source = 'admin' then 'shop' else 'customer' end);

  if v_line is not null then
    select id into v_customer from public.customers where business_id = p_business_id and line_user_id = v_line;
  end if;
  if v_customer is null and v_phone is not null then
    select id into v_customer from public.customers where business_id = p_business_id and phone = v_phone
     order by created_at limit 1;
  end if;
  if v_customer is null then
    insert into public.customers (business_id, name, phone, email, line_user_id)
    values (p_business_id, v_name, v_phone, nullif(trim(p_customer->>'email'), ''), v_line)
    returning id into v_customer;
  end if;

  select hold_minutes into v_hold_minutes from public.business_booking_settings where business_id = p_business_id;
  insert into public.bookings (business_id, customer_id, customer_name, offering_id, start_at, end_at, party_size, status,
                               hold_expires_at, price_snapshot, source, notes)
  values (p_business_id, v_customer, v_name, p_offering_id, p_start_at, (v_plan->>'end_at')::timestamptz,
          coalesce(p_party_size, 1), case when p_hold then 'held' else 'confirmed' end,
          case when p_hold then now() + make_interval(mins => coalesce(v_hold_minutes, 10)) end,
          v_plan->'price', p_source, p_notes)
  returning id into v_id;
  -- a held booking waits for its deposit; the amount is fixed now, whatever the shop changes later
  if p_hold then
    update public.bookings set deposit_due = public.booking_deposit_due(p_business_id, (v_plan->'price'->>'total')::numeric)
     where id = v_id;
  end if;
  perform public.booking_insert_resources(p_business_id, v_id, v_plan);
  perform public.booking_save_addons(p_business_id, v_id, v_plan);
  return public.booking_result(v_id);
end;
$$;

create or replace function public.booking_result(p_booking_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', b.id, 'business_id', b.business_id, 'customer_id', b.customer_id, 'offering_id', b.offering_id,
    'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at, 'party_size', b.party_size,
    'hold_expires_at', b.hold_expires_at, 'price', b.price_snapshot, 'deposit_due', b.deposit_due,
    'resources', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('resource_id', r.resource_id, 'units', r.units, 'addon_id', r.addon_id))
                                            order by r.addon_id nulls first, r.resource_id)
                             from public.booking_resources r where r.booking_id = b.id and r.active), '[]'::jsonb),
    'addons', coalesce((select jsonb_agg(jsonb_build_object('addon_id', a.addon_id, 'name', a.name, 'quantity', a.quantity, 'total', a.total)
                                         order by a.name)
                          from public.booking_addons a where a.booking_id = b.id), '[]'::jsonb)
  )
  from public.bookings b where b.id = p_booking_id;
$$;

-- The customer sends a slip from their link (the public API, as the service role)
create or replace function public.customer_submit_slip(p_business_id uuid, p_token_hash text, p_image bytea)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  select * into v_booking from public.bookings
   where business_id = p_business_id and manage_token_hash = p_token_hash
   for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_booking.status = 'held' and v_booking.hold_expires_at <= now() then
    perform public.expire_holds(p_business_id);
    raise exception using errcode = 'BK409', message = 'HOLD_EXPIRED';
  end if;
  if v_booking.status not in ('held','pending') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if (select count(*) from public.payment_slips where booking_id = v_booking.id) >= 5 then
    raise exception using errcode = 'BK422', message = 'TOO_MANY_SLIPS';
  end if;
  insert into public.payment_slips (business_id, booking_id, image) values (p_business_id, v_booking.id, p_image);
  if v_booking.status = 'held' then
    perform set_config('booking.status_reason', 'ลูกค้าส่งสลิปมัดจำ', true);
    update public.bookings set status = 'pending', hold_expires_at = null where id = v_booking.id;
    perform set_config('booking.status_reason', '', true);
  end if;
  return public.booking_result(v_booking.id);
end;
$$;

-- The shop has the money: the booking is confirmed and the deposit is recorded on its bill
-- (p_amount defaults to deposit_due; 0 confirms without recording money)
create or replace function public.confirm_deposit(p_booking_id uuid, p_amount numeric default null, p_method text default 'transfer')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_amount numeric;
  v_bill uuid;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_booking.business_id);
  if v_booking.status = 'held' and v_booking.hold_expires_at <= now() then
    perform public.expire_holds(v_booking.business_id);
    raise exception using errcode = 'BK409', message = 'HOLD_EXPIRED';
  end if;
  if v_booking.status not in ('held','pending') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  v_amount := round(coalesce(p_amount, v_booking.deposit_due, 0), 2);
  -- never more than the booking costs (or the deposit asked, for a booking with no price)
  if v_amount < 0
     or v_amount > greatest(coalesce((v_booking.price_snapshot->>'total')::numeric, 0), coalesce(v_booking.deposit_due, 0))
     or coalesce(p_method, '') not in ('cash','transfer','card','online') then
    raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
  end if;

  perform set_config('booking.status_reason', 'ร้านยืนยันมัดจำ', true);
  update public.bookings set status = 'confirmed', hold_expires_at = null where id = p_booking_id;
  perform set_config('booking.status_reason', '', true);
  if v_amount > 0 then
    v_bill := public.open_bill(v_booking.business_id, p_booking_id);
    insert into public.bill_payments (business_id, bill_id, kind, method, amount, recorded_by)
    values (v_booking.business_id, v_bill, 'deposit', p_method, v_amount, auth.uid());
  end if;
  return public.booking_result(p_booking_id);
end;
$$;

revoke execute on function public.booking_deposit_due(uuid, numeric) from public, anon, authenticated;
grant execute on function public.booking_deposit_due(uuid, numeric) to service_role;
revoke execute on function public.customer_submit_slip(uuid, text, bytea) from public, anon, authenticated;
grant execute on function public.customer_submit_slip(uuid, text, bytea) to service_role;
revoke execute on function public.confirm_deposit(uuid, numeric, text) from public, anon;
grant execute on function public.confirm_deposit(uuid, numeric, text) to authenticated, service_role;
