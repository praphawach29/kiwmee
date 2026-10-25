-- Flexible booking v2, step 3 (docs/FLEXIBLE_BOOKING_DESIGN.md §4.6, §6 "ตอนกดยืนยัน")
-- Creating, moving, confirming and cancelling bookings. The database checks the slot again
-- itself and never trusts what the booking page showed:
--   * capacity 1 (a stylist, a court): the exclusion constraint refuses overlaps, and the
--     resource's advisory lock makes the second of two simultaneous requests see the first
--   * capacity > 1 (a class): the advisory lock serialises requests and the head count at the
--     busiest moment of the range must stay within capacity
--   * holds (waiting for payment) expire after business_booking_settings.hold_minutes; they are
--     released before every booking so an abandoned hold never blocks a real customer
--
-- Errors carry a reason code in the message so the API can show it as the options engine does:
--   BK409  the slot was just taken          (FULLY_BOOKED, HOLD_EXPIRED)
--   BK422  the request cannot be booked     (BUSINESS_CLOSED, STAFF_OFF, NOT_OFFERED, ...)
--   BK404  no such booking / shop
-- Who may call: shop members (signed in) for their own shop, and the service role (the public
-- booking API, step 4). anon cannot call any of these directly.

-- 1. Status history is written by a trigger, so every path records it the same way
create or replace function public.bookings_log_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into public.booking_status_history (business_id, booking_id, from_status, to_status, changed_by, reason)
    values (new.business_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(),
            nullif(current_setting('booking.status_reason', true), ''));
  end if;
  return new;
end;
$$;
create trigger bookings_log_status after insert or update of status on public.bookings
  for each row execute function public.bookings_log_status();

-- 2. Release holds whose time is up
create or replace function public.expire_holds(p_business_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform set_config('booking.status_reason', 'hold expired', true);
  update public.bookings
     set status = 'expired', hold_expires_at = null
   where status = 'held' and hold_expires_at <= now()
     and (p_business_id is null or business_id = p_business_id);
  get diagnostics v_count = row_count;
  perform set_config('booking.status_reason', '', true);
  return v_count;
end;
$$;

-- 3. Price: the most specific rule that matches wins (priority, then a time window, then days).
-- per_hour adds up minute by minute, so 16:00–18:00 across a 17:00 price change is 300 + 450.
create or replace function public.booking_price(p_offering_id uuid, p_start_at timestamptz, p_end_at timestamptz,
                                                p_party_size int, p_timezone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_local timestamp := p_start_at at time zone p_timezone;
  v_rule public.price_rules;
  v_total numeric;
begin
  select * into v_rule from public.price_rules r
   where r.offering_id = p_offering_id
     and (r.days_of_week is null or extract(dow from v_local)::int = any(r.days_of_week))
     and (r.start_time is null or (v_local::time >= r.start_time and v_local::time < r.end_time))
   order by r.priority desc, (r.start_time is not null) desc, (r.days_of_week is not null) desc
   limit 1;
  if not found then
    return jsonb_build_object('unit', null, 'total', 0, 'currency', 'THB', 'note', 'no price rule');
  end if;

  if v_rule.unit = 'per_booking' then
    v_total := v_rule.amount;
  elsif v_rule.unit = 'per_person' then
    v_total := v_rule.amount * p_party_size;
  else
    select coalesce(sum(w.amount / 60), 0) into v_total
    from generate_series(p_start_at, p_end_at - interval '1 minute', interval '1 minute') m(at)
    cross join lateral (
      select r.amount from public.price_rules r
       where r.offering_id = p_offering_id and r.unit = 'per_hour'
         and (r.days_of_week is null or extract(dow from m.at at time zone p_timezone)::int = any(r.days_of_week))
         and (r.start_time is null or ((m.at at time zone p_timezone)::time >= r.start_time
                                      and (m.at at time zone p_timezone)::time < r.end_time))
       order by r.priority desc, (r.start_time is not null) desc, (r.days_of_week is not null) desc
       limit 1
    ) w;
  end if;
  return jsonb_build_object('unit', v_rule.unit, 'amount', v_rule.amount, 'party_size', p_party_size,
                            'total', round(v_total, 2), 'currency', 'THB');
end;
$$;

-- 4. Check one concrete booking and pick its resources. The same rules as src/v2/options-engine.js,
-- for a single slot. p_override (admin bookings) skips the lead time and the start-time grid.
create or replace function public.booking_plan(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_resource_id uuid,
  p_duration_minutes int,
  p_party_size int,
  p_exclude_booking_id uuid,
  p_override boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_lead int := 15; v_step int := 15; v_advance int := 30;
  v_off public.offerings;
  v_dur int;
  v_end timestamptz;
  v_range_end timestamptz;
  v_local timestamp; v_local_end timestamp;
  v_date date; v_dow int; v_start_t time; v_end_t time;
  v_open time; v_close time; v_is_open boolean;
  v_pin_kind text;
  v_req record;
  v_res record;
  v_sched public.resource_schedules;
  v_units int;
  v_peak int;
  v_found uuid;
  v_saw_busy boolean;
  v_kinds int := 0;
  v_picked jsonb := '[]'::jsonb;
begin
  select timezone into v_tz from public.businesses where id = p_business_id;
  if v_tz is null then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  select min_lead_minutes, slot_interval_minutes, max_advance_days into v_lead, v_step, v_advance
    from public.business_booking_settings where business_id = p_business_id;
  v_lead := coalesce(v_lead, 15); v_step := coalesce(v_step, 15); v_advance := coalesce(v_advance, 30);

  select * into v_off from public.offerings where id = p_offering_id and business_id = p_business_id and active;
  if not found then
    raise exception using errcode = 'BK422', message = 'NOT_OFFERED';
  end if;
  if p_party_size is null or p_party_size < 1 or p_party_size > v_off.max_party_size then
    raise exception using errcode = 'BK422', message = 'INVALID_PARTY_SIZE';
  end if;
  if v_off.duration_mode = 'fixed' then
    if p_duration_minutes is not null and p_duration_minutes <> v_off.duration_minutes then
      raise exception using errcode = 'BK422', message = 'INVALID_DURATION';
    end if;
    v_dur := v_off.duration_minutes;
  else
    v_dur := p_duration_minutes;
    if v_dur is null or v_dur < v_off.min_minutes or v_dur > v_off.max_minutes
       or (v_dur - v_off.min_minutes) % v_off.step_minutes <> 0 then
      raise exception using errcode = 'BK422', message = 'INVALID_DURATION';
    end if;
  end if;

  v_end := p_start_at + make_interval(mins => v_dur);
  v_range_end := v_end + make_interval(mins => v_off.buffer_after_minutes);
  v_local := p_start_at at time zone v_tz;
  v_local_end := v_end at time zone v_tz;
  v_date := v_local::date;
  v_dow := extract(dow from v_local)::int;
  v_start_t := v_local::time;
  v_end_t := v_local_end::time;

  -- booking window
  if p_start_at <= now() or v_date > (now() at time zone v_tz)::date + v_advance then
    raise exception using errcode = 'BK422', message = 'OUTSIDE_BOOKING_WINDOW';
  end if;
  if not p_override and p_start_at <= now() + make_interval(mins => v_lead) then
    raise exception using errcode = 'BK422', message = 'PAST_WORKING_HOURS';
  end if;

  -- shop hours (a shop with no hours set yet is open 10–19, as the options engine assumes)
  if exists (select 1 from public.business_hours where business_id = p_business_id) then
    select is_open, open_time, close_time into v_is_open, v_open, v_close
      from public.business_hours where business_id = p_business_id and day_of_week = v_dow;
    v_is_open := coalesce(v_is_open, false);
  else
    v_is_open := true; v_open := '10:00'; v_close := '19:00';
  end if;
  if not v_is_open or exists (
    select 1 from public.business_closures c
     where c.business_id = p_business_id and c.date = v_date
       and (c.is_full_day or (v_start_t < c.end_time and v_end_t > c.start_time))
  ) then
    raise exception using errcode = 'BK422', message = 'BUSINESS_CLOSED';
  end if;
  if v_local_end::date <> v_date or v_start_t < v_open or v_end_t > v_close then
    raise exception using errcode = 'BK422', message = 'NO_WORKING_WINDOW';
  end if;
  if not p_override and (extract(epoch from (v_start_t - v_open)) / 60)::int % v_step <> 0 then
    raise exception using errcode = 'BK422', message = 'INVALID_TIME';
  end if;

  if p_resource_id is not null then
    select kind into v_pin_kind from public.resources
     where id = p_resource_id and business_id = p_business_id and active;
    if v_pin_kind is null then
      raise exception using errcode = 'BK422', message = 'NOT_OFFERED';
    end if;
  end if;

  -- each kind of resource the offering needs (an offering with no requirement rows needs one of
  -- each kind linked to it, as the options engine assumes)
  for v_req in
    select q.kind, q.units_per_booking from public.offering_requirements q where q.offering_id = p_offering_id
    union all
    select distinct r.kind, 'one'::text from public.offering_resources l join public.resources r on r.id = l.resource_id
     where l.offering_id = p_offering_id
       and not exists (select 1 from public.offering_requirements q where q.offering_id = p_offering_id)
  loop
    v_kinds := v_kinds + 1;
    v_units := case when v_req.units_per_booking = 'party_size' then p_party_size else 1 end;
    v_found := null;
    v_saw_busy := false;
    for v_res in
      select r.id, r.capacity from public.resources r
        join public.offering_resources l on l.resource_id = r.id and l.offering_id = p_offering_id
       where r.business_id = p_business_id and r.active and r.kind = v_req.kind
         and (v_pin_kind is distinct from v_req.kind or r.id = p_resource_id)
       order by r.sort_order, r.name, r.id
    loop
      select * into v_sched from public.resource_schedules where resource_id = v_res.id and day_of_week = v_dow;
      if found and (not v_sched.is_working or v_start_t < v_sched.start_time or v_end_t > v_sched.end_time) then
        continue;
      end if;
      if exists (
        select 1 from public.resource_time_off t
         where t.resource_id = v_res.id and t.date = v_date
           and (t.is_full_day or (v_start_t < t.end_time and v_end_t > t.start_time))
      ) then
        continue;
      end if;

      perform pg_advisory_xact_lock(hashtextextended('booking_resource:' || v_res.id::text, 0));
      -- head count at the busiest moment of [start, end + buffer)
      select coalesce(max(load), 0) into v_peak
      from (
        select (select coalesce(sum(b.units), 0) from public.booking_resources b
                 where b.resource_id = v_res.id and b.active
                   and b.booking_id is distinct from p_exclude_booking_id
                   and b.range @> p.at) as load
        from (
          select p_start_at as at
          union
          select lower(b.range) from public.booking_resources b
           where b.resource_id = v_res.id and b.active
             and b.booking_id is distinct from p_exclude_booking_id
             and b.range && tstzrange(p_start_at, v_range_end)
             and lower(b.range) > p_start_at
        ) p
      ) x;
      if v_peak + v_units > v_res.capacity then
        v_saw_busy := true;
        continue;
      end if;
      v_found := v_res.id;
      exit;
    end loop;

    if v_found is null then
      if v_saw_busy then
        raise exception using errcode = 'BK409', message = 'FULLY_BOOKED';
      elsif not exists (
        select 1 from public.offering_resources l join public.resources r on r.id = l.resource_id
         where l.offering_id = p_offering_id and r.active and r.kind = v_req.kind
           and (v_pin_kind is distinct from v_req.kind or r.id = p_resource_id)
      ) then
        raise exception using errcode = 'BK422', message = 'NOT_OFFERED';
      elsif v_pin_kind = v_req.kind then
        raise exception using errcode = 'BK422', message = 'STAFF_OFF';
      else
        raise exception using errcode = 'BK422', message = 'NO_WORKING_WINDOW';
      end if;
    end if;
    v_picked := v_picked || jsonb_build_object('resource_id', v_found, 'kind', v_req.kind, 'units', v_units);
  end loop;

  if v_kinds = 0 then
    raise exception using errcode = 'BK422', message = 'NOT_OFFERED';
  end if;
  -- a pinned resource must be one the offering actually uses
  if v_pin_kind is not null and not exists (select 1 from jsonb_array_elements(v_picked) e where (e->>'resource_id')::uuid = p_resource_id) then
    raise exception using errcode = 'BK422', message = 'NOT_OFFERED';
  end if;

  return jsonb_build_object(
    'start_at', p_start_at,
    'end_at', v_end,
    'range_end', v_range_end,
    'resources', v_picked,
    'price', public.booking_price(p_offering_id, p_start_at, v_end, p_party_size, v_tz)
  );
end;
$$;

-- Signed-in callers must belong to the shop; the service role (no auth.uid()) is trusted.
create or replace function public.booking_assert_access(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_business_member(p_business_id) then
    raise exception 'not a member of this shop' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.booking_insert_resources(p_business_id uuid, p_booking_id uuid, p_plan jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.booking_resources (business_id, booking_id, resource_id, units, range)
  select p_business_id, p_booking_id, (e->>'resource_id')::uuid, (e->>'units')::int,
         tstzrange((p_plan->>'start_at')::timestamptz, (p_plan->>'range_end')::timestamptz, '[)')
  from jsonb_array_elements(p_plan->'resources') e;
exception when exclusion_violation then
  raise exception using errcode = 'BK409', message = 'FULLY_BOOKED';
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
    'hold_expires_at', b.hold_expires_at, 'price', b.price_snapshot,
    'resources', coalesce((select jsonb_agg(jsonb_build_object('resource_id', r.resource_id, 'units', r.units) order by r.resource_id)
                             from public.booking_resources r where r.booking_id = b.id and r.active), '[]'::jsonb)
  )
  from public.bookings b where b.id = p_booking_id;
$$;

-- 5. Create. p_customer = { name, phone?, email?, line_user_id? }; an existing customer of the shop
-- is matched by LINE id, then by phone. p_hold = true keeps the slot for hold_minutes while the
-- customer pays (confirm_booking ends the hold); otherwise the booking is confirmed at once.
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
  insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at, party_size, status,
                               hold_expires_at, price_snapshot, source, notes)
  values (p_business_id, v_customer, p_offering_id, p_start_at, (v_plan->>'end_at')::timestamptz,
          coalesce(p_party_size, 1), case when p_hold then 'held' else 'confirmed' end,
          case when p_hold then now() + make_interval(mins => coalesce(v_hold_minutes, 10)) end,
          v_plan->'price', p_source, p_notes)
  returning id into v_id;
  perform public.booking_insert_resources(p_business_id, v_id, v_plan);
  return public.booking_result(v_id);
end;
$$;

-- 6. Move to another time (and optionally another resource or length). The booking does not
-- block itself while it is checked.
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_start_at timestamptz,
  p_resource_id uuid default null,
  p_duration_minutes int default null,
  p_source text default 'web'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_resource uuid;
  v_plan jsonb;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_booking.business_id);
  perform public.expire_holds(v_booking.business_id);
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.status not in ('held','pending','confirmed') then
    raise exception using errcode = 'BK422', message = case when v_booking.status = 'expired' then 'HOLD_EXPIRED' else 'NOT_CHANGEABLE' end;
  end if;

  -- Unless told otherwise, keep the stylist (or court) the customer chose; resources the shop
  -- assigns itself (customer_picks false) may change.
  v_resource := p_resource_id;
  if v_resource is null then
    select br.resource_id into v_resource
      from public.booking_resources br
      join public.resources r on r.id = br.resource_id
      join public.offering_requirements q on q.offering_id = v_booking.offering_id and q.kind = r.kind and q.customer_picks
     where br.booking_id = p_booking_id
     limit 1;
  end if;
  v_plan := public.booking_plan(v_booking.business_id, v_booking.offering_id, p_start_at, v_resource,
                                coalesce(p_duration_minutes,
                                         case when (select duration_mode from public.offerings where id = v_booking.offering_id) = 'customer_choice'
                                              then (extract(epoch from v_booking.end_at - v_booking.start_at) / 60)::int end),
                                v_booking.party_size, p_booking_id, p_source = 'admin');
  delete from public.booking_resources where booking_id = p_booking_id;
  perform public.booking_insert_resources(v_booking.business_id, p_booking_id, v_plan);
  update public.bookings
     set start_at = p_start_at, end_at = (v_plan->>'end_at')::timestamptz, price_snapshot = v_plan->'price'
   where id = p_booking_id;
  return public.booking_result(p_booking_id);
end;
$$;

-- 7. A held booking becomes confirmed (payment received), unless the hold already ran out
create or replace function public.confirm_booking(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
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
  if v_booking.status in ('held','pending') then
    update public.bookings set status = 'confirmed', hold_expires_at = null where id = p_booking_id;
  elsif v_booking.status <> 'confirmed' then
    raise exception using errcode = 'BK422', message = case when v_booking.status = 'expired' then 'HOLD_EXPIRED' else 'NOT_CHANGEABLE' end;
  end if;
  return public.booking_result(p_booking_id);
end;
$$;

-- 8. Cancel. The bookings_release_resources trigger frees the slot.
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform public.booking_assert_access(v_booking.business_id);
  if v_booking.status = 'cancelled' then
    return public.booking_result(p_booking_id);
  end if;
  if v_booking.status not in ('held','pending','confirmed') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  perform set_config('booking.status_reason', coalesce(p_reason, ''), true);
  update public.bookings set status = 'cancelled', hold_expires_at = null where id = p_booking_id;
  perform set_config('booking.status_reason', '', true);
  return public.booking_result(p_booking_id);
end;
$$;

-- 9. Grants. Supabase grants every new function to anon and authenticated directly, so name them.
-- Callable by shop members and the service role:
revoke execute on function public.create_booking(uuid, uuid, timestamptz, jsonb, uuid, int, int, boolean, text, text) from public, anon;
revoke execute on function public.reschedule_booking(uuid, timestamptz, uuid, int, text) from public, anon;
revoke execute on function public.confirm_booking(uuid) from public, anon;
revoke execute on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.create_booking(uuid, uuid, timestamptz, jsonb, uuid, int, int, boolean, text, text) to authenticated, service_role;
grant execute on function public.reschedule_booking(uuid, timestamptz, uuid, int, text) to authenticated, service_role;
grant execute on function public.confirm_booking(uuid) to authenticated, service_role;
grant execute on function public.cancel_booking(uuid, text) to authenticated, service_role;

-- Internal: the service role only (pg_cron or the API calls expire_holds)
revoke execute on function public.expire_holds(uuid) from public, anon, authenticated;
revoke execute on function public.booking_price(uuid, timestamptz, timestamptz, int, text) from public, anon, authenticated;
revoke execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.booking_assert_access(uuid) from public, anon, authenticated;
revoke execute on function public.booking_insert_resources(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.booking_result(uuid) from public, anon, authenticated;
revoke execute on function public.bookings_log_status() from public, anon, authenticated;
grant execute on function public.expire_holds(uuid) to service_role;
grant execute on function public.booking_price(uuid, timestamptz, timestamptz, int, text) to service_role;
grant execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean) to service_role;
grant execute on function public.booking_assert_access(uuid) to service_role;
grant execute on function public.booking_insert_resources(uuid, uuid, jsonb) to service_role;
grant execute on function public.booking_result(uuid) to service_role;
