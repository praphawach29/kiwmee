-- Shop bookings page (app/dashboard, "การจอง"): the shop records a booking afterwards — a walk-in
-- it forgot to enter, a visit from before the shop used Kiwmee — so the day's list and takings
-- are complete. The usual checks still hold (shop hours, the stylist's schedule, no double
-- booking); only "the time has passed" is lifted, for up to a year back.
--
-- booking_plan gains p_allow_past (default false, so create_booking and reschedule_booking keep
-- calling it as before). record_past_booking stores the visit as completed / checked_in / no_show
-- straight away; a no-show does not hold its stylist.

drop function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean);

create or replace function public.booking_plan(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_resource_id uuid,
  p_duration_minutes int,
  p_party_size int,
  p_exclude_booking_id uuid,
  p_override boolean,
  p_allow_past boolean default false
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

  -- booking window (a booking the shop records afterwards may start up to a year ago)
  if p_allow_past then
    if p_start_at < now() - interval '366 days' then
      raise exception using errcode = 'BK422', message = 'OUTSIDE_BOOKING_WINDOW';
    end if;
  elsif p_start_at <= now() or v_date > (now() at time zone v_tz)::date + v_advance then
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
  insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at, party_size, status,
                               price_snapshot, source, notes)
  values (p_business_id, v_customer, p_offering_id, p_start_at, (v_plan->>'end_at')::timestamptz,
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

revoke execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean, boolean) to service_role;
revoke execute on function public.record_past_booking(uuid, uuid, timestamptz, jsonb, text, uuid, int, int, text) from public, anon;
grant execute on function public.record_past_booking(uuid, uuid, timestamptz, jsonb, text, uuid, int, int, text) to authenticated, service_role;
