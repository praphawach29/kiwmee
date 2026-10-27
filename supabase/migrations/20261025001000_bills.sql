-- Bills (docs/LOYALTY_DESIGN.md §5, step 6d): what a customer actually paid, apart from bookings.
-- A bill comes from a booking (the shop closes it after the visit) or stands alone (a walk-in
-- sale, or a shop that takes no bookings at all). Points (step 6e) will be earned from closed
-- bills, so the rules that matter later are enforced here already:
--   * one bill per booking (a void bill does not count), closed once
--   * a bill closes only when what was paid (deposits + payments) equals its total
--   * a closed bill is never edited; money goes back as a refund row (owners only)
--   * closing a booking's bill marks the booking completed; "undo" is refused once it is paid
--
-- Errors use the booking RPC codes: BK404 NOT_FOUND, BK422 with a reason (NOT_CHANGEABLE,
-- ALREADY_CLOSED, PAYMENT_MISMATCH, INVALID_PAYMENT, INVALID_AMOUNT, REFUND_TOO_MUCH, HAS_PAYMENTS,
-- BILL_CLOSED). Members (staff too) open and close bills; only owners refund.

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  booking_id uuid,
  customer_id uuid,
  customer_name text,                           -- walk-in without a customer record
  line_user_id text,                            -- the member who earns points (step 6e)
  title text not null check (length(trim(title)) > 0),
  status text not null default 'open' check (status in ('open','closed','void')),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),   -- from a reward (step 6e)
  total numeric(12,2) generated always as (greatest(subtotal - discount, 0)) stored,
  reward_id uuid,                               -- step 6e
  note text,
  void_reason text,
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (booking_id, business_id) references public.bookings(id, business_id),
  foreign key (customer_id, business_id) references public.customers(id, business_id),
  check ((status = 'closed') = (closed_at is not null))
);
create unique index bills_one_per_booking on public.bills(booking_id) where booking_id is not null and status <> 'void';
create index bills_business_created_idx on public.bills(business_id, created_at);
create trigger bills_set_updated_at before update on public.bills
  for each row execute function public.set_updated_at();

create table public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bill_id uuid not null,
  kind text not null check (kind in ('deposit','payment','refund')),
  method text not null check (method in ('cash','transfer','card','online')),
  amount numeric(12,2) not null check (amount > 0),   -- a refund is positive too
  note text,
  recorded_by uuid,                             -- null = the service role (online payment, step 6f)
  created_at timestamptz not null default now(),
  foreign key (bill_id, business_id) references public.bills(id, business_id) on delete cascade
);
create index bill_payments_bill_idx on public.bill_payments(bill_id);
create index bill_payments_business_created_idx on public.bill_payments(business_id, created_at);

-- RLS: members read; every write goes through the RPCs below
do $$
declare t text;
begin
  foreach t in array array['bills','bill_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_business_member(business_id))', t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.bill_result(p_bill_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', b.id, 'business_id', b.business_id, 'booking_id', b.booking_id, 'status', b.status, 'title', b.title,
    'customer_name', coalesce(b.customer_name, c.name), 'subtotal', b.subtotal, 'discount', b.discount, 'total', b.total,
    'paid', coalesce((select sum(p.amount) from public.bill_payments p where p.bill_id = b.id and p.kind <> 'refund'), 0),
    'refunded', coalesce((select sum(p.amount) from public.bill_payments p where p.bill_id = b.id and p.kind = 'refund'), 0),
    'closed_at', b.closed_at, 'note', b.note
  )
  from public.bills b left join public.customers c on c.id = b.customer_id
  where b.id = p_bill_id;
$$;

-- Open a bill: from a booking (price, title and customer come from it; an existing bill is
-- returned instead of a second one) or a walk-in sale (title and amount from the shop).
create or replace function public.open_bill(
  p_business_id uuid,
  p_booking_id uuid default null,
  p_title text default null,
  p_subtotal numeric default null,
  p_customer_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_id uuid;
  v_title text := nullif(trim(p_title), '');
begin
  perform public.booking_assert_access(p_business_id);
  if p_subtotal is not null and p_subtotal < 0 then
    raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
  end if;

  if p_booking_id is null then
    insert into public.bills (business_id, title, subtotal, customer_name, created_by)
    values (p_business_id, coalesce(v_title, 'ขายหน้าร้าน'), coalesce(p_subtotal, 0),
            nullif(trim(p_customer_name), ''), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_booking from public.bookings where id = p_booking_id and business_id = p_business_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  select id into v_id from public.bills where booking_id = p_booking_id and status <> 'void';
  if v_id is not null then
    return v_id;
  end if;
  if v_booking.status not in ('pending','confirmed','checked_in','completed') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  insert into public.bills (business_id, booking_id, customer_id, line_user_id, title, subtotal, created_by)
  select p_business_id, v_booking.id, v_booking.customer_id, c.line_user_id,
         coalesce(v_title, o.name), coalesce(p_subtotal, (v_booking.price_snapshot->>'total')::numeric, 0), auth.uid()
    from public.offerings o, public.customers c
   where o.id = v_booking.offering_id and c.id = v_booking.customer_id
  returning id into v_id;
  return v_id;
end;
$$;

-- Close: p_payments = [{ "method": "cash", "amount": 450 }, ...]. Deposits already on the bill count
-- toward the total; together they must match it exactly. p_subtotal changes the amount first
-- (the customer added a service).
create or replace function public.close_bill(
  p_bill_id uuid,
  p_payments jsonb default '[]'::jsonb,
  p_subtotal numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_payment jsonb;
  v_paid numeric;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_bill.business_id);
  if v_bill.status = 'closed' then
    raise exception using errcode = 'BK422', message = 'ALREADY_CLOSED';
  elsif v_bill.status <> 'open' then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if p_subtotal is not null then
    if p_subtotal < 0 then
      raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
    end if;
    update public.bills set subtotal = p_subtotal where id = p_bill_id;
  end if;

  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'BK422', message = 'INVALID_PAYMENT';
  end if;
  for v_payment in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if coalesce(jsonb_typeof(v_payment->'amount'), '') <> 'number' or (v_payment->>'amount')::numeric <= 0
       or coalesce(v_payment->>'method', '') not in ('cash','transfer','card','online') then
      raise exception using errcode = 'BK422', message = 'INVALID_PAYMENT';
    end if;
    insert into public.bill_payments (business_id, bill_id, kind, method, amount, recorded_by)
    values (v_bill.business_id, p_bill_id, 'payment', v_payment->>'method', round((v_payment->>'amount')::numeric, 2), auth.uid());
  end loop;

  select coalesce(sum(amount), 0) into v_paid from public.bill_payments where bill_id = p_bill_id and kind <> 'refund';
  if v_paid <> (select total from public.bills where id = p_bill_id) then
    raise exception using errcode = 'BK422', message = 'PAYMENT_MISMATCH';
  end if;

  update public.bills
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), note = coalesce(nullif(trim(p_note), ''), note)
   where id = p_bill_id;
  if v_bill.booking_id is not null then
    perform set_config('booking.status_reason', 'ปิดบิล', true);
    update public.bookings set status = 'completed', hold_expires_at = null
     where id = v_bill.booking_id and status in ('pending','confirmed','checked_in');
    perform set_config('booking.status_reason', '', true);
  end if;
  return public.bill_result(p_bill_id);
end;
$$;

-- Money back on a closed bill (owners only). Points come back in proportion in step 6e.
create or replace function public.refund_bill(p_bill_id uuid, p_amount numeric, p_method text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
  v_left numeric;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if auth.uid() is not null and not public.is_business_owner(v_bill.business_id) then
    raise exception 'only the shop owner can refund' using errcode = '42501';
  end if;
  if v_bill.status <> 'closed' then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if p_amount is null or p_amount <= 0 or coalesce(p_method, '') not in ('cash','transfer','card','online') then
    raise exception using errcode = 'BK422', message = 'INVALID_PAYMENT';
  end if;
  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into v_left
    from public.bill_payments where bill_id = p_bill_id;
  if round(p_amount, 2) > v_left then
    raise exception using errcode = 'BK422', message = 'REFUND_TOO_MUCH';
  end if;
  insert into public.bill_payments (business_id, bill_id, kind, method, amount, note, recorded_by)
  values (v_bill.business_id, p_bill_id, 'refund', p_method, round(p_amount, 2), nullif(trim(p_reason), ''), auth.uid());
  return public.bill_result(p_bill_id);
end;
$$;

-- An open bill opened by mistake; one with money on it is refunded instead
create or replace function public.void_bill(p_bill_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills;
begin
  select * into v_bill from public.bills where id = p_bill_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_bill.business_id);
  if v_bill.status <> 'open' then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if exists (select 1 from public.bill_payments where bill_id = p_bill_id) then
    raise exception using errcode = 'BK422', message = 'HAS_PAYMENTS';
  end if;
  update public.bills set status = 'void', void_reason = nullif(trim(p_reason), '') where id = p_bill_id;
  return public.bill_result(p_bill_id);
end;
$$;

-- set_booking_status (…000700) again: a paid booking cannot be taken back from completed
create or replace function public.set_booking_status(p_booking_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_allowed text[];
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_booking.business_id);
  if v_booking.status = p_status then
    return public.booking_result(p_booking_id);
  end if;
  v_allowed := case v_booking.status
    when 'confirmed' then array['checked_in','completed','no_show']
    when 'pending' then array['checked_in','completed','no_show']
    when 'checked_in' then array['completed','confirmed']
    when 'completed' then array['checked_in']
    else array[]::text[]
  end;
  if not (p_status = any(v_allowed)) then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if v_booking.status = 'completed' and exists (
    select 1 from public.bills where booking_id = p_booking_id and status = 'closed'
  ) then
    raise exception using errcode = 'BK422', message = 'BILL_CLOSED';
  end if;
  perform set_config('booking.status_reason', coalesce(p_reason, ''), true);
  update public.bookings set status = p_status, hold_expires_at = null where id = p_booking_id;
  perform set_config('booking.status_reason', '', true);
  return public.booking_result(p_booking_id);
end;
$$;

revoke execute on function public.bill_result(uuid) from public, anon, authenticated;
grant execute on function public.bill_result(uuid) to service_role;
revoke execute on function public.open_bill(uuid, uuid, text, numeric, text) from public, anon;
revoke execute on function public.close_bill(uuid, jsonb, numeric, text) from public, anon;
revoke execute on function public.refund_bill(uuid, numeric, text, text) from public, anon;
revoke execute on function public.void_bill(uuid, text) from public, anon;
grant execute on function public.open_bill(uuid, uuid, text, numeric, text) to authenticated, service_role;
grant execute on function public.close_bill(uuid, jsonb, numeric, text) to authenticated, service_role;
grant execute on function public.refund_bill(uuid, numeric, text, text) to authenticated, service_role;
grant execute on function public.void_bill(uuid, text) to authenticated, service_role;
