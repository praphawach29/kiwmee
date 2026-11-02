-- Add-ons in bookings (docs/FLEXIBLE_BOOKING_DESIGN.md §11, steps B–C): a booking may take add-ons,
-- checked and priced in the database like everything else (the page's choices are never trusted).
--
--   booking_addon_items  the picks { "<addon_id>": quantity } checked against the shop's settings
--                        mode 'customer' = every rule · 'shop' = the shop may skip a group's minimum ·
--                        'keep' = moving a booking keeps what it took even if the shop changed settings
--   booking_plan         + p_addons, p_addon_mode: extra minutes lengthen the booking; an add-on that
--                        uses a kind of resource holds one (or several) for the whole booking;
--                        price_snapshot gains `lines` (offering + each add-on) when there are add-ons
--   create_booking / record_past_booking  + p_addons (new last argument)
--   reschedule_booking   carries the add-ons to the new time
--   booking_save_addons  writes booking_addons from the plan
--   add_branch           copies add-on groups to the new branch
-- New error reasons: BK409 ADDON_UNAVAILABLE (nothing of that kind left for that time),
-- BK422 ADDON_INVALID (not this shop's / not for this offering / switched off / too many),
-- BK422 ADDON_GROUP_RULE (fewer or more picks than the group allows).

create or replace function public.booking_addon_items(p_business_id uuid, p_offering_id uuid, p_addons jsonb, p_mode text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_key text;
  v_value jsonb;
  v_a record;
  v_g record;
  v_n int;
begin
  if p_addons is not null and jsonb_typeof(p_addons) <> 'object' then
    raise exception using errcode = 'BK422', message = 'ADDON_INVALID';
  end if;
  for v_key, v_value in select key, value from jsonb_each(coalesce(p_addons, '{}'::jsonb)) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}') !~ '^[0-9]{1,4}$' then
      raise exception using errcode = 'BK422', message = 'ADDON_INVALID';
    end if;
  end loop;
  -- in the shop's order (group, then add-on), so the price lines read as the page lists them
  for v_a in
    select a.id, a.group_id, a.name, a.price_unit, a.amount, a.max_quantity, a.adds_minutes, a.uses_kind,
           (p.value #>> '{}')::int as qty,
           a.active and g.active and l.offering_id is not null as usable
      from jsonb_each(coalesce(p_addons, '{}'::jsonb)) p
      left join public.addons a on a.id = p.key::uuid and a.business_id = p_business_id
      left join public.addon_groups g on g.id = a.group_id
      left join public.offering_addon_groups l on l.group_id = g.id and l.offering_id = p_offering_id
     where (p.value #>> '{}')::int > 0
     order by g.sort_order, g.name, a.sort_order, a.name
  loop
    if v_a.id is null or (p_mode <> 'keep' and (not v_a.usable or v_a.qty > v_a.max_quantity)) then
      raise exception using errcode = 'BK422', message = 'ADDON_INVALID';
    end if;
    v_items := v_items || jsonb_build_object('addon_id', v_a.id, 'group_id', v_a.group_id, 'name', v_a.name,
      'quantity', v_a.qty, 'price_unit', v_a.price_unit, 'amount', v_a.amount, 'adds_minutes', v_a.adds_minutes,
      'uses_kind', v_a.uses_kind);
  end loop;

  if p_mode <> 'keep' then
    for v_g in
      select g.id, g.min_select, g.max_select from public.addon_groups g
        join public.offering_addon_groups l on l.group_id = g.id and l.offering_id = p_offering_id
       where g.business_id = p_business_id and g.active
         and exists (select 1 from public.addons a where a.group_id = g.id and a.active)
    loop
      select count(*) into v_n from jsonb_array_elements(v_items) e where (e->>'group_id')::uuid = v_g.id;
      if (v_g.max_select is not null and v_n > v_g.max_select) or (p_mode = 'customer' and v_n < v_g.min_select) then
        raise exception using errcode = 'BK422', message = 'ADDON_GROUP_RULE';
      end if;
    end loop;
  end if;
  return v_items;
end;
$$;

drop function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean, boolean);

create or replace function public.booking_plan(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_resource_id uuid,
  p_duration_minutes int,
  p_party_size int,
  p_exclude_booking_id uuid,
  p_override boolean,
  p_allow_past boolean default false,
  p_addons jsonb default null,
  p_addon_mode text default 'customer'
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
  v_items jsonb;
  v_item jsonb;
  v_extra int := 0;
  v_need int;
  v_take int;
  v_base_end timestamptz;
  v_price jsonb;
  v_lines jsonb;
  v_addon_total numeric := 0;
  v_minutes int;
  v_line_total numeric;
  v_out_addons jsonb := '[]'::jsonb;
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

  -- add-ons: checked against the shop's settings; their extra minutes lengthen the booking
  v_items := public.booking_addon_items(p_business_id, p_offering_id, p_addons, p_addon_mode);
  select coalesce(sum((e->>'adds_minutes')::int * (e->>'quantity')::int), 0) into v_extra from jsonb_array_elements(v_items) e;
  v_base_end := p_start_at + make_interval(mins => v_dur);
  v_end := v_base_end + make_interval(mins => v_extra);
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

  -- add-ons that hold a resource (a racket, a driver): any active resource of that kind with room
  -- for the whole booking; a quantity may be spread over several resources of the kind
  for v_item in select e from jsonb_array_elements(v_items) e where e->>'uses_kind' is not null loop
    v_need := (v_item->>'quantity')::int;
    for v_res in
      select r.id, r.capacity from public.resources r
       where r.business_id = p_business_id and r.active and r.kind = v_item->>'uses_kind'
         and not exists (select 1 from jsonb_array_elements(v_picked) e where (e->>'resource_id')::uuid = r.id)
       order by r.sort_order, r.name, r.id
    loop
      exit when v_need <= 0;
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
      v_take := least(v_need, v_res.capacity - v_peak);
      continue when v_take <= 0;
      v_picked := v_picked || jsonb_build_object('resource_id', v_res.id, 'kind', v_item->>'uses_kind', 'units', v_take,
                                                 'addon_id', v_item->>'addon_id');
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception using errcode = 'BK409', message = 'ADDON_UNAVAILABLE';
    end if;
  end loop;

  -- price: the offering for its own minutes, then each add-on (snapshot lines when there are any)
  v_price := public.booking_price(p_offering_id, p_start_at, v_base_end, p_party_size, v_tz);
  if jsonb_array_length(v_items) > 0 then
    v_minutes := v_dur + v_extra;
    v_lines := jsonb_build_array(jsonb_build_object('kind', 'offering', 'name', v_off.name, 'total', v_price->'total'));
    for v_item in select e from jsonb_array_elements(v_items) e loop
      v_line_total := round((v_item->>'amount')::numeric * case v_item->>'price_unit'
        when 'per_hour' then v_minutes / 60.0 * (v_item->>'quantity')::int
        when 'per_day' then ceil(v_minutes / 1440.0) * (v_item->>'quantity')::int
        when 'per_person' then p_party_size
        else (v_item->>'quantity')::int end, 2);
      v_addon_total := v_addon_total + v_line_total;
      v_lines := v_lines || jsonb_build_object('kind', 'addon', 'addon_id', v_item->>'addon_id', 'name', v_item->>'name',
                                               'quantity', (v_item->>'quantity')::int, 'unit', v_item->>'price_unit',
                                               'amount', (v_item->>'amount')::numeric, 'total', v_line_total);
      v_out_addons := v_out_addons || jsonb_build_object('addon_id', v_item->>'addon_id', 'name', v_item->>'name',
                                                         'quantity', (v_item->>'quantity')::int, 'total', v_line_total);
    end loop;
    v_price := v_price || jsonb_build_object('total', round((v_price->>'total')::numeric + v_addon_total, 2), 'lines', v_lines);
  end if;

  return jsonb_build_object(
    'start_at', p_start_at,
    'end_at', v_end,
    'range_end', v_range_end,
    'resources', v_picked,
    'addons', v_out_addons,
    'price', v_price
  );
end;
$$;

-- resources an add-on holds are marked with it
create or replace function public.booking_insert_resources(p_business_id uuid, p_booking_id uuid, p_plan jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.booking_resources (business_id, booking_id, resource_id, units, range, addon_id)
  select p_business_id, p_booking_id, (e->>'resource_id')::uuid, (e->>'units')::int,
         tstzrange((p_plan->>'start_at')::timestamptz, (p_plan->>'range_end')::timestamptz, '[)'),
         nullif(e->>'addon_id', '')::uuid
  from jsonb_array_elements(p_plan->'resources') e;
exception when exclusion_violation then
  raise exception using errcode = 'BK409', message = 'FULLY_BOOKED';
end;
$$;

create or replace function public.booking_save_addons(p_business_id uuid, p_booking_id uuid, p_plan jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.booking_addons where booking_id = p_booking_id;
  insert into public.booking_addons (business_id, booking_id, addon_id, quantity, name, total)
  select p_business_id, p_booking_id, (e->>'addon_id')::uuid, (e->>'quantity')::int, e->>'name', (e->>'total')::numeric
    from jsonb_array_elements(coalesce(p_plan->'addons', '[]'::jsonb)) e;
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
    'resources', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('resource_id', r.resource_id, 'units', r.units, 'addon_id', r.addon_id))
                                            order by r.addon_id nulls first, r.resource_id)
                             from public.booking_resources r where r.booking_id = b.id and r.active), '[]'::jsonb),
    'addons', coalesce((select jsonb_agg(jsonb_build_object('addon_id', a.addon_id, 'name', a.name, 'quantity', a.quantity, 'total', a.total)
                                         order by a.name)
                          from public.booking_addons a where a.booking_id = b.id), '[]'::jsonb)
  )
  from public.bookings b where b.id = p_booking_id;
$$;

drop function public.create_booking(uuid, uuid, timestamptz, jsonb, uuid, int, int, boolean, text, text);

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
  perform public.booking_insert_resources(p_business_id, v_id, v_plan);
  perform public.booking_save_addons(p_business_id, v_id, v_plan);
  return public.booking_result(v_id);
end;
$$;

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
  v_addons jsonb;
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
  -- the add-ons go along, priced again for the new time (and re-picked if they hold a resource)
  select jsonb_object_agg(addon_id::text, quantity) into v_addons from public.booking_addons where booking_id = p_booking_id;
  v_plan := public.booking_plan(v_booking.business_id, v_booking.offering_id, p_start_at, v_resource,
                                coalesce(p_duration_minutes,
                                         case when (select duration_mode from public.offerings where id = v_booking.offering_id) = 'customer_choice'
                                              then (extract(epoch from v_booking.end_at - v_booking.start_at) / 60)::int
                                                   -- the length the customer chose, without the add-ons' extra minutes
                                                   - coalesce((select sum(a.adds_minutes * ba.quantity)::int from public.booking_addons ba
                                                                 join public.addons a on a.id = ba.addon_id
                                                                where ba.booking_id = p_booking_id), 0) end),
                                v_booking.party_size, p_booking_id, p_source = 'admin', false, v_addons, 'keep');
  delete from public.booking_resources where booking_id = p_booking_id;
  perform public.booking_insert_resources(v_booking.business_id, p_booking_id, v_plan);
  perform public.booking_save_addons(v_booking.business_id, p_booking_id, v_plan);
  update public.bookings
     set start_at = p_start_at, end_at = (v_plan->>'end_at')::timestamptz, price_snapshot = v_plan->'price'
   where id = p_booking_id;
  return public.booking_result(p_booking_id);
end;
$$;

drop function public.record_past_booking(uuid, uuid, timestamptz, jsonb, text, uuid, int, int, text);

create or replace function public.record_past_booking(
  p_business_id uuid,
  p_offering_id uuid,
  p_start_at timestamptz,
  p_customer jsonb,
  p_status text default 'completed',
  p_resource_id uuid default null,
  p_duration_minutes int default null,
  p_party_size int default 1,
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
                                coalesce(p_party_size, 1), null, true, true, p_addons, 'shop');

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
  perform public.booking_save_addons(p_business_id, v_id, v_plan);
  if p_status = 'no_show' then
    update public.booking_resources set active = false where booking_id = v_id;
  end if;
  return public.booking_result(v_id);
end;
$$;

-- a new branch copied from another gets its add-on groups too (offerings mapped to the copies)
create or replace function public.branch_copy_addons(p_from uuid, p_to uuid, p_off_map jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group record;
  v_new uuid;
begin
  for v_group in select * from public.addon_groups where business_id = p_from and active loop
    insert into public.addon_groups (business_id, name, min_select, max_select, sort_order)
    values (p_to, v_group.name, v_group.min_select, v_group.max_select, v_group.sort_order)
    returning id into v_new;
    insert into public.addons (business_id, group_id, name, description, media, price_unit, amount, max_quantity,
                               adds_minutes, uses_kind, sort_order)
    select p_to, v_new, name, description, media, price_unit, amount, max_quantity, adds_minutes, uses_kind, sort_order
      from public.addons where group_id = v_group.id and active;
    insert into public.offering_addon_groups (business_id, offering_id, group_id)
    select p_to, (p_off_map->>l.offering_id::text)::uuid, v_new
      from public.offering_addon_groups l
     where l.group_id = v_group.id and p_off_map ? l.offering_id::text;
  end loop;
end;
$$;

create or replace function public.add_branch(
  p_brand_id uuid,
  p_name text,
  p_slug text,
  p_copy_from uuid default null,
  p_copy_resources boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_src public.businesses;
  v_off record;
  v_new_off uuid;
  v_res record;
  v_new_res uuid;
  v_res_map jsonb := '{}'::jsonb;
  v_off_map jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not public.is_brand_owner(p_brand_id) then
    raise exception 'only the brand owner can add a branch' using errcode = '42501';
  end if;
  if not exists (select 1 from public.brands where id = p_brand_id) then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  perform 1 from public.brands where id = p_brand_id for update;   -- one branch at a time per brand
  if (select count(*) from public.businesses where brand_id = p_brand_id)
     >= public.brand_branch_limit(public.brand_plan(p_brand_id)) then
    raise exception using errcode = 'BK422', message = 'PLAN_LIMIT';
  end if;
  if p_copy_from is not null then
    select * into v_src from public.businesses where id = p_copy_from and brand_id = p_brand_id;
    if not found then
      raise exception using errcode = 'BK404', message = 'NOT_FOUND';
    end if;
  end if;

  insert into public.businesses (name, slug, kind, timezone, brand_id)
  values (p_name, p_slug, coalesce(v_src.kind, 'salon'), coalesce(v_src.timezone, 'Asia/Bangkok'), p_brand_id)
  returning id into v_id;
  perform public.brand_owners_join(p_brand_id, v_id);

  if v_src.id is null then
    insert into public.business_booking_settings (business_id) values (v_id);
    insert into public.booking_flows (business_id) values (v_id);
    insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
    select v_id, d, true, '10:00', '19:00' from generate_series(0, 6) d;
    return v_id;
  end if;

  insert into public.business_booking_settings (business_id, min_lead_minutes, slot_interval_minutes, max_advance_days,
                                                hold_minutes, customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours)
  select v_id, min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
         customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours
    from public.business_booking_settings where business_id = v_src.id;
  if not found then
    insert into public.business_booking_settings (business_id) values (v_id);
  end if;
  insert into public.booking_flows (business_id, category, entry, require, optional, "then", options)
  select v_id, category, entry, require, optional, "then", options from public.booking_flows where business_id = v_src.id;
  if not exists (select 1 from public.booking_flows where business_id = v_id) then
    insert into public.booking_flows (business_id) values (v_id);
  end if;
  insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
  select v_id, day_of_week, is_open, open_time, close_time from public.business_hours where business_id = v_src.id;

  for v_off in select * from public.offerings where business_id = v_src.id and active loop
    insert into public.offerings (business_id, category, name, description, duration_mode, duration_minutes, min_minutes,
                                  max_minutes, step_minutes, buffer_after_minutes, max_party_size, sort_order)
    values (v_id, v_off.category, v_off.name, v_off.description, v_off.duration_mode, v_off.duration_minutes, v_off.min_minutes,
            v_off.max_minutes, v_off.step_minutes, v_off.buffer_after_minutes, v_off.max_party_size, v_off.sort_order)
    returning id into v_new_off;
    v_off_map := v_off_map || jsonb_build_object(v_off.id::text, v_new_off);
    insert into public.offering_requirements (business_id, offering_id, kind, customer_picks, units_per_booking)
    select v_id, v_new_off, kind, customer_picks, units_per_booking from public.offering_requirements where offering_id = v_off.id;
    insert into public.price_rules (business_id, offering_id, unit, amount, days_of_week, start_time, end_time, priority)
    select v_id, v_new_off, unit, amount, days_of_week, start_time, end_time, priority from public.price_rules where offering_id = v_off.id;
  end loop;

  perform public.branch_copy_addons(v_src.id, v_id, v_off_map);

  if p_copy_resources then
    for v_res in select * from public.resources where business_id = v_src.id and active loop
      insert into public.resources (business_id, kind, name, capacity, sort_order, media)
      values (v_id, v_res.kind, v_res.name, v_res.capacity, v_res.sort_order, v_res.media)
      returning id into v_new_res;
      v_res_map := v_res_map || jsonb_build_object(v_res.id::text, v_new_res);
      insert into public.resource_schedules (business_id, resource_id, day_of_week, is_working, start_time, end_time)
      select v_id, v_new_res, day_of_week, is_working, start_time, end_time from public.resource_schedules where resource_id = v_res.id;
    end loop;
    insert into public.offering_resources (business_id, offering_id, resource_id)
    select v_id, (v_off_map->>l.offering_id::text)::uuid, (v_res_map->>l.resource_id::text)::uuid
      from public.offering_resources l
     where l.business_id = v_src.id and v_off_map ? l.offering_id::text and v_res_map ? l.resource_id::text;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.booking_addon_items(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.booking_addon_items(uuid, uuid, jsonb, text) to service_role;
revoke execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.booking_plan(uuid, uuid, timestamptz, uuid, int, int, uuid, boolean, boolean, jsonb, text) to service_role;
revoke execute on function public.booking_save_addons(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.booking_save_addons(uuid, uuid, jsonb) to service_role;
revoke execute on function public.branch_copy_addons(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.branch_copy_addons(uuid, uuid, jsonb) to service_role;
revoke execute on function public.create_booking(uuid, uuid, timestamptz, jsonb, uuid, int, int, boolean, text, text, jsonb) from public, anon;
grant execute on function public.create_booking(uuid, uuid, timestamptz, jsonb, uuid, int, int, boolean, text, text, jsonb) to authenticated, service_role;
revoke execute on function public.record_past_booking(uuid, uuid, timestamptz, jsonb, text, uuid, int, int, text, jsonb) from public, anon;
grant execute on function public.record_past_booking(uuid, uuid, timestamptz, jsonb, text, uuid, int, int, text, jsonb) to authenticated, service_role;
