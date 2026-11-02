-- Bookings over several days (docs/FLEXIBLE_BOOKING_DESIGN.md 11.7, stage E1): renting out a car, a
-- camera or equipment by the day. An offering in the new 'days' mode is booked for 24-hour periods
-- (min_days–max_days): picked up at a time the customer chooses, back at the same time of day N days
-- later. Nothing new is stored on a booking: start_at/end_at simply span the days, and the existing
-- no-overlap rule keeps a car from being lent twice.
--
--   offerings.duration_mode  'days' (+ min_days, max_days)
--   price_rules.unit         'per_day' = amount × days
--   booking_plan             a 'days' offering: the shop must be open at pick-up and at return
--                            (RETURN_CLOSED when not), the days in between do not matter; a resource
--                            marked off on any day of it cannot be lent
--   booking_price            per_day
--   reschedule_booking       keeps the number of days when only the time moves
--   add_branch               copies min_days / max_days to a new branch

alter table public.offerings drop constraint offerings_duration_mode_check;
alter table public.offerings add constraint offerings_duration_mode_check check (duration_mode in ('fixed', 'customer_choice', 'days'));
alter table public.offerings add column min_days int check (min_days between 1 and 90);
alter table public.offerings add column max_days int check (max_days between 1 and 90);
alter table public.offerings add constraint offerings_days_check check (duration_mode <> 'days' or (min_days is not null and max_days >= min_days));

alter table public.price_rules drop constraint price_rules_unit_check;
alter table public.price_rules add constraint price_rules_unit_check check (unit in ('per_booking', 'per_hour', 'per_person', 'per_day'));

-- Is the shop open at this local date and time? (a shop with no hours yet is open 10–19)
create or replace function public.booking_shop_open_at(p_business_id uuid, p_date date, p_time time)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.business_closures c
                  where c.business_id = p_business_id and c.date = p_date
                    and (c.is_full_day or (p_time >= c.start_time and p_time < c.end_time))) then false
    when not exists (select 1 from public.business_hours where business_id = p_business_id) then p_time between '10:00' and '19:00'
    else coalesce((select h.is_open and p_time between h.open_time and h.close_time from public.business_hours h
                    where h.business_id = p_business_id and h.day_of_week = extract(dow from p_date)::int), false)
  end
$$;
revoke execute on function public.booking_shop_open_at(uuid, date, time) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.booking_plan(p_business_id uuid, p_offering_id uuid, p_start_at timestamp with time zone, p_resource_id uuid, p_duration_minutes integer, p_party_size integer, p_exclude_booking_id uuid, p_override boolean, p_allow_past boolean DEFAULT false, p_addons jsonb DEFAULT NULL::jsonb, p_addon_mode text DEFAULT 'customer'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  elsif v_off.duration_mode = 'days' then
    -- lent out for whole days (24-hour periods): back at the same time of day
    v_dur := p_duration_minutes;
    if v_dur is null or v_dur % 1440 <> 0 or v_dur / 1440 < v_off.min_days or v_dur / 1440 > v_off.max_days then
      raise exception using errcode = 'BK422', message = 'INVALID_DURATION';
    end if;
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

  if v_off.duration_mode = 'days' then
    -- days: the shop must be open when the customer picks up and when they bring it back; the days in
    -- between (nights, a closed Monday) do not matter
    if not public.booking_shop_open_at(p_business_id, v_date, v_start_t) then
      raise exception using errcode = 'BK422', message = 'BUSINESS_CLOSED';
    end if;
    if not public.booking_shop_open_at(p_business_id, v_local_end::date, v_end_t) then
      raise exception using errcode = 'BK422', message = 'RETURN_CLOSED';
    end if;
    if exists (select 1 from public.business_hours where business_id = p_business_id) then
      select open_time into v_open from public.business_hours where business_id = p_business_id and day_of_week = v_dow;
    else
      v_open := '10:00';
    end if;
  else
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
      if v_off.duration_mode = 'days' then
        -- lent out for days: not if it is marked off on any day of the rental
        if exists (select 1 from public.resource_time_off t
                    where t.resource_id = v_res.id and t.date between v_date and v_local_end::date) then
          continue;
        end if;
      else
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
      if v_off.duration_mode = 'days' then
        -- lent out for days: not if it is marked off on any day of the rental
        if exists (select 1 from public.resource_time_off t
                    where t.resource_id = v_res.id and t.date between v_date and v_local_end::date) then
          continue;
        end if;
      else
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
$function$;

CREATE OR REPLACE FUNCTION public.booking_price(p_offering_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_party_size integer, p_timezone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  elsif v_rule.unit = 'per_day' then
    -- whole days: 24-hour periods, a part of a day counts as a day
    v_total := v_rule.amount * greatest(ceil(extract(epoch from (p_end_at - p_start_at)) / 86400.0), 1);
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
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_booking(p_booking_id uuid, p_start_at timestamp with time zone, p_resource_id uuid DEFAULT NULL::uuid, p_duration_minutes integer DEFAULT NULL::integer, p_source text DEFAULT 'web'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                                         case when (select duration_mode from public.offerings where id = v_booking.offering_id) in ('customer_choice', 'days')
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
$function$;

CREATE OR REPLACE FUNCTION public.add_branch(p_brand_id uuid, p_name text, p_slug text, p_copy_from uuid DEFAULT NULL::uuid, p_copy_resources boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                                  max_minutes, step_minutes, min_days, max_days, buffer_after_minutes, max_party_size, sort_order)
    values (v_id, v_off.category, v_off.name, v_off.description, v_off.duration_mode, v_off.duration_minutes, v_off.min_minutes,
            v_off.max_minutes, v_off.step_minutes, v_off.min_days, v_off.max_days, v_off.buffer_after_minutes, v_off.max_party_size, v_off.sort_order)
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
$function$;
