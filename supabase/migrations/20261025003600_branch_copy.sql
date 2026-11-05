-- IMPORTANT: run this on booking-v2 (SQL Editor) BEFORE merging the code that relies on it.
-- Adding a branch copied the shop's setup, but only the columns that existed when that copy was
-- written. Columns added later were silently dropped: the floor plan (layout_row/col/w/h, …002900),
-- shop media (…001600), amenities/about/address (…002400–002500), rental days and required documents
-- (…002600–002700), deposit/payment info (…002200), document retention and slip auto-confirm
-- (…002700/…003300), and add-on groups with their equipment (…002000). A branch created today
-- therefore looked like a stripped copy of its parent.
--
-- This replaces add_branch with a complete copy. The signature, authorization and grants are the
-- same as …001600; only the copied columns and the add-on copy are new.
begin;

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
  v_grp record;
  v_new_grp uuid;
  v_add record;
  v_res_map jsonb := '{}'::jsonb;
  v_off_map jsonb := '{}'::jsonb;
  v_grp_map jsonb := '{}'::jsonb;
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

  insert into public.businesses (name, slug, kind, timezone, brand_id, media, amenities, about, address, map_url)
  values (p_name, p_slug, coalesce(v_src.kind, 'salon'), coalesce(v_src.timezone, 'Asia/Bangkok'), p_brand_id,
          coalesce(v_src.media, '[]'::jsonb), coalesce(v_src.amenities, '{}'), v_src.about, v_src.address, v_src.map_url)
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
                                                hold_minutes, customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours,
                                                deposit_mode, deposit_value, payment_info, line_reminders,
                                                document_retention_days, slip_auto_confirm)
  select v_id, min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
         customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours,
         deposit_mode, deposit_value, payment_info, line_reminders,
         document_retention_days, slip_auto_confirm
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
                                  max_minutes, step_minutes, min_days, max_days, required_documents, buffer_after_minutes,
                                  max_party_size, sort_order, media)
    values (v_id, v_off.category, v_off.name, v_off.description, v_off.duration_mode, v_off.duration_minutes, v_off.min_minutes,
            v_off.max_minutes, v_off.step_minutes, v_off.min_days, v_off.max_days, v_off.required_documents,
            v_off.buffer_after_minutes, v_off.max_party_size, v_off.sort_order, v_off.media)
    returning id into v_new_off;
    v_off_map := v_off_map || jsonb_build_object(v_off.id::text, v_new_off);
    insert into public.offering_requirements (business_id, offering_id, kind, customer_picks, units_per_booking)
    select v_id, v_new_off, kind, customer_picks, units_per_booking from public.offering_requirements where offering_id = v_off.id;
    insert into public.price_rules (business_id, offering_id, unit, amount, days_of_week, start_time, end_time, priority)
    select v_id, v_new_off, unit, amount, days_of_week, start_time, end_time, priority from public.price_rules where offering_id = v_off.id;
  end loop;

  if p_copy_resources then
    for v_res in select * from public.resources where business_id = v_src.id and active loop
      insert into public.resources (business_id, kind, name, capacity, sort_order, media,
                                    layout_row, layout_col, layout_w, layout_h)
      values (v_id, v_res.kind, v_res.name, v_res.capacity, v_res.sort_order, v_res.media,
              v_res.layout_row, v_res.layout_col, v_res.layout_w, v_res.layout_h)
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

  -- add-ons are part of the offering setup (equipment a court rents), so they travel with the copy
  for v_grp in select * from public.addon_groups where business_id = v_src.id loop
    insert into public.addon_groups (business_id, name, min_select, max_select, sort_order, active)
    values (v_id, v_grp.name, v_grp.min_select, v_grp.max_select, v_grp.sort_order, v_grp.active)
    returning id into v_new_grp;
    v_grp_map := v_grp_map || jsonb_build_object(v_grp.id::text, v_new_grp);
    for v_add in select * from public.addons where group_id = v_grp.id and business_id = v_src.id loop
      insert into public.addons (business_id, group_id, name, description, media, price_unit, amount, max_quantity,
                                 adds_minutes, uses_kind, sort_order, active)
      values (v_id, v_new_grp, v_add.name, v_add.description, v_add.media, v_add.price_unit, v_add.amount, v_add.max_quantity,
              v_add.adds_minutes, v_add.uses_kind, v_add.sort_order, v_add.active);
    end loop;
  end loop;
  insert into public.offering_addon_groups (business_id, offering_id, group_id)
  select v_id, (v_off_map->>l.offering_id::text)::uuid, (v_grp_map->>l.group_id::text)::uuid
    from public.offering_addon_groups l
   where l.business_id = v_src.id and v_off_map ? l.offering_id::text and v_grp_map ? l.group_id::text;

  return v_id;
end;
$$;

commit;
