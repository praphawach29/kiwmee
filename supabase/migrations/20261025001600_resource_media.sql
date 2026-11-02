-- IMPORTANT: apply on booking-v2 BEFORE deploying resource gallery readers.
-- Reference-only media; retain existing business_members owner-write/member-read RLS.
begin;

alter table public.resources add column if not exists media jsonb not null default '[]'::jsonb;
alter table public.resources drop constraint if exists resources_media_check;
alter table public.resources add constraint resources_media_check check (public.valid_catalog_media(media));
comment on column public.resources.media is 'Ordered gallery: up to 8 {url,alt} references; HTTPS or /demo-media/ paths only. URL <=2048, alt <=200. No backend fetch.';

-- Preserve the existing add_branch authorization, signature, grants and booking setup.
-- Only the resource copy gains media; inactive resources remain excluded.
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

commit;
