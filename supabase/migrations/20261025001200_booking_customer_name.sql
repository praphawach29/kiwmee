-- Each booking keeps the name typed when it was made. customers.name stays the first name seen for
-- that phone number, so a second person using the same number no longer shows up under the first one.
-- create_or_replace keeps the existing grants (same signatures as …000300 and …000800).

alter table public.bookings add column customer_name text;

-- older bookings take the name of their customer record
update public.bookings b set customer_name = c.name from public.customers c where c.id = b.customer_id and b.customer_name is null;

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
  p_notes text default null
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
                                coalesce(p_party_size, 1), null, p_source = 'admin');

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
  perform public.booking_insert_resources(p_business_id, v_id, v_plan);
  return public.booking_result(v_id);
end;
$$;

create or replace function public.record_past_booking(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_customer jsonb,
  p_status text default 'completed',
  p_resource_id uuid default null,
  p_duration_minutes int default null,
  p_party_size int default 1,
  p_notes text default null
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
  v_id uuid;
begin
  perform public.booking_assert_access(p_business_id);
  if v_name is null then
    raise exception using errcode = 'BK422', message = 'CUSTOMER_NAME_REQUIRED';
  end if;
  if p_status is null or p_status not in ('completed','checked_in','no_show') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if p_start_at >= now() then
    raise exception using errcode = 'BK422', message = 'NOT_IN_PAST';
  end if;
  v_plan := public.booking_plan(p_business_id, p_offering_id, p_start_at, p_resource_id, p_duration_minutes,
                                coalesce(p_party_size, 1), null, true, true);

  if v_phone is not null then
    select id into v_customer from public.customers where business_id = p_business_id and phone = v_phone
     order by created_at limit 1;
  end if;
  if v_customer is null then
    insert into public.customers (business_id, name, phone) values (p_business_id, v_name, v_phone)
    returning id into v_customer;
  end if;

  perform set_config('booking.status_reason', 'บันทึกย้อนหลัง', true);
  insert into public.bookings (business_id, customer_id, customer_name, offering_id, start_at, end_at, party_size, status,
                               price_snapshot, source, notes)
  values (p_business_id, v_customer, v_name, p_offering_id, p_start_at, (v_plan->>'end_at')::timestamptz,
          coalesce(p_party_size, 1), p_status, v_plan->'price', 'admin', p_notes)
  returning id into v_id;
  perform set_config('booking.status_reason', '', true);
  perform public.booking_insert_resources(p_business_id, v_id, v_plan);
  if p_status = 'no_show' then
    update public.booking_resources set active = false where booking_id = v_id;
  end if;
  return public.booking_result(v_id);
end;
$$;
