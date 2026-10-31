-- OPERATIONAL SEED ONLY: never run automatically during migration/deployment.
-- Order: apply media migration (20261025001400_*) -> deploy /demo-media/*.svg -> owner runs this.
-- Run the WHOLE file as a trusted booking-v2 SQL Editor / database-owner session.
-- No production execution is authorized by merely preparing this file.
-- This is not a migration, does not bypass/change RLS, and never creates a shop/owner.
-- Fixed namespace 7d91c600-74b1-4ac7-9801-*: suffixes 1xx offering, 2xx court,
-- 3xx requirement, 4xx price, 500 fallback flow. Existing mismatched rows abort, not overwrite.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog, public;

do $seed$
declare
  v_business uuid;
  v_owner uuid;
  v_brand constant uuid := '6ca1c8b4-94cf-4fb8-8f68-38634ec40cb5';
  v_expected jsonb := '{"offerings":[],"resources":[],"offering_requirements":[],"price_rules":[]}'::jsonb;
  v_demo jsonb;
  v_row jsonb;
  v_existing jsonb;
  v_table text;
  v_other_table text;
  v_columns text;
  v_offering uuid;
  v_resource uuid;
  v_requirement uuid;
  v_price uuid;
  v_flow constant uuid := '7d91c600-74b1-4ac7-9801-000000000500';
  v_media jsonb;
  v_new_media jsonb;
  v_image jsonb;
  v_count int;
  v_flow_row public.booking_flows%rowtype;
  v_demo_ids uuid[] := array[
    '7d91c600-74b1-4ac7-9801-000000000101'::uuid,
    '7d91c600-74b1-4ac7-9801-000000000102'::uuid,
    '7d91c600-74b1-4ac7-9801-000000000103'::uuid
  ];
begin
  -- Guard all identity/schema prerequisites BEFORE any persistent write.
  perform pg_advisory_xact_lock(hashtextextended('kiwmee:jackshop:demo-sports:v1', 0));
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'businesses'
                   and column_name = 'media' and data_type = 'jsonb')
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'offerings'
                      and column_name = 'media' and data_type = 'jsonb') then
    raise exception 'Apply the businesses/offerings media migration before this seed';
  end if;

  select id into strict v_business from public.businesses
   where slug = 'jackshop' and kind = 'court' and brand_id = v_brand for update;
  select id into strict v_owner from auth.users
   where lower(email) = 'praphawach@gmail.com' for share;
  perform 1 from public.business_members
   where business_id = v_business and user_id = v_owner and role = 'owner' for share;
  if not found then raise exception 'JackShop owner membership mismatch; no changes allowed'; end if;
  perform 1 from public.brand_members
   where brand_id = v_brand and user_id = v_owner and role = 'owner' for share;
  if not found then raise exception 'JackShop brand owner mismatch; no changes allowed'; end if;

  -- Short operational locks close races with concurrent catalog edits / additional price rules.
  -- Timeout rather than wait indefinitely; do not run while the owner is editing the catalog.
  lock table public.offerings, public.resources, public.offering_requirements,
    public.offering_resources, public.price_rules, public.booking_flows,
    public.business_hours, public.business_booking_settings in share row exclusive mode;

  for v_demo in select value from jsonb_array_elements('[
    {"n":1,"name":"[ตัวอย่าง] สนามแบดมินตัน","court":"[ตัวอย่าง] คอร์ตแบดมินตัน 1","amount":200,"url":"/demo-media/badminton.svg","alt":"ภาพประกอบตัวอย่างสนามแบดมินตัน ไม่ใช่ภาพสถานที่จริง"},
    {"n":2,"name":"[ตัวอย่าง] สนามเทนนิส","court":"[ตัวอย่าง] คอร์ตเทนนิส 1","amount":300,"url":"/demo-media/tennis.svg","alt":"ภาพประกอบตัวอย่างสนามเทนนิส ไม่ใช่ภาพสถานที่จริง"},
    {"n":3,"name":"[ตัวอย่าง] สนามฟุตบอล","court":"[ตัวอย่าง] สนามฟุตบอล 1","amount":1200,"url":"/demo-media/football.svg","alt":"ภาพประกอบตัวอย่างสนามฟุตบอล ไม่ใช่ภาพสถานที่จริง"}
  ]'::jsonb) loop
    v_offering := ('7d91c600-74b1-4ac7-9801-00000000010' || (v_demo->>'n'))::uuid;
    v_resource := ('7d91c600-74b1-4ac7-9801-00000000020' || (v_demo->>'n'))::uuid;
    v_requirement := ('7d91c600-74b1-4ac7-9801-00000000030' || (v_demo->>'n'))::uuid;
    v_price := ('7d91c600-74b1-4ac7-9801-00000000040' || (v_demo->>'n'))::uuid;
    v_image := jsonb_build_object('url', v_demo->>'url', 'alt', v_demo->>'alt');
    v_expected := jsonb_set(v_expected, '{offerings}', (v_expected->'offerings') || jsonb_build_array(jsonb_build_object(
      'id', v_offering, 'business_id', v_business, 'category', '[ตัวอย่าง] กีฬา',
      'name', v_demo->>'name', 'description', 'บริการและราคาเพื่อสาธิตเท่านั้น ภาพเป็นภาพประกอบ ไม่ใช่ภาพสถานที่จริง กรุณายืนยันรายละเอียดกับเจ้าของร้านก่อนจอง',
      'duration_mode', 'customer_choice', 'duration_minutes', null,
      'min_minutes', 60, 'max_minutes', 180, 'step_minutes', 60,
      'buffer_after_minutes', 0, 'max_party_size', 1, 'sort_order', 9000 + (v_demo->>'n')::int,
      'active', true, 'media', jsonb_build_array(v_image))));
    v_expected := jsonb_set(v_expected, '{resources}', (v_expected->'resources') || jsonb_build_array(jsonb_build_object(
      'id', v_resource, 'business_id', v_business, 'kind', 'court', 'name', v_demo->>'court',
      'capacity', 1, 'member_user_id', null, 'sort_order', 9000 + (v_demo->>'n')::int, 'active', true)));
    v_expected := jsonb_set(v_expected, '{offering_requirements}', (v_expected->'offering_requirements') || jsonb_build_array(jsonb_build_object(
      'id', v_requirement, 'business_id', v_business, 'offering_id', v_offering,
      'kind', 'court', 'customer_picks', true, 'units_per_booking', 'one')));
    v_expected := jsonb_set(v_expected, '{price_rules}', (v_expected->'price_rules') || jsonb_build_array(jsonb_build_object(
      'id', v_price, 'business_id', v_business, 'offering_id', v_offering,
      'unit', 'per_hour', 'amount', (v_demo->>'amount')::numeric,
      'days_of_week', null, 'start_time', null, 'end_time', null, 'priority', 0)));
  end loop;

  -- Validate every reserved ID globally, not only within the target tenant.
  -- A manually changed demo row also fails closed: never silently reset owner changes.
  foreach v_table in array array['offerings','resources','offering_requirements','price_rules'] loop
    for v_row in select value from jsonb_array_elements(v_expected->v_table) loop
      foreach v_other_table in array array['offerings','resources','offering_requirements','price_rules','booking_flows'] loop
        execute format('select to_jsonb(t) from public.%I t where id = $1', v_other_table)
          into v_existing using (v_row->>'id')::uuid;
        if v_existing is not null and (v_other_table <> v_table or not (v_existing @> v_row)
          or (v_table = 'offerings' and v_existing->'media' <> v_row->'media')) then
          raise exception 'Reserved demo ID % collision or drift in %; nothing overwritten', v_row->>'id', v_other_table;
        end if;
      end loop;
    end loop;
  end loop;
  foreach v_table in array array['offerings','resources','offering_requirements','price_rules','booking_flows'] loop
    execute format('select to_jsonb(t) from public.%I t where id = $1', v_table)
      into v_existing using v_flow;
    if v_existing is not null and (v_table <> 'booking_flows'
      or not (v_existing @> jsonb_build_object('business_id', v_business, 'category', null,
        'entry', array['offering'], 'require', array['offering','resource','duration','date','time'],
        'optional', array[]::text[], 'then', array['customer'],
        'options', jsonb_build_object('show_any_staff', false)))) then
      raise exception 'Reserved fallback flow ID collision or drift; nothing overwritten';
    end if;
  end loop;

  if exists (select 1 from public.offering_requirements q where q.offering_id = any(v_demo_ids)
      and not exists (select 1 from jsonb_array_elements(v_expected->'offering_requirements') e
                      where (e->>'id')::uuid = q.id))
     or exists (select 1 from public.price_rules p where p.offering_id = any(v_demo_ids)
      and not exists (select 1 from jsonb_array_elements(v_expected->'price_rules') e
                      where (e->>'id')::uuid = p.id))
     or exists (select 1 from public.offering_resources l where l.offering_id = any(v_demo_ids)
      and (l.business_id <> v_business or l.resource_id <>
        replace(l.offering_id::text, '00000000010', '00000000020')::uuid)) then
    raise exception 'Unexpected requirements/rates/resource links on demo offerings; inspect manually';
  end if;

  select media into v_media from public.businesses where id = v_business;
  if v_media is null or jsonb_typeof(v_media) <> 'array' then
    raise exception 'Shop media is not an array; inspect rather than replace it';
  end if;
  v_new_media := v_media;
  for v_row in select value from jsonb_array_elements(v_expected->'offerings') loop
    v_image := v_row->'media'->0;
    if not exists (select 1 from jsonb_array_elements(v_new_media) e where e->>'url' = v_image->>'url') then
      v_new_media := v_new_media || jsonb_build_array(v_image);
    end if;
  end loop;
  if jsonb_array_length(v_new_media) > 8 then
    raise exception 'Shop gallery has insufficient free slots for all demo illustrations (max 8); preserve real media and ask owner to free slots first';
  end if;

  -- Persistent writes begin only after all guards pass. Explicit columns preserve DB defaults
  -- for created_at / updated_at. ON CONFLICT never updates an existing catalog entity.
  foreach v_table in array array['resources','offerings','offering_requirements','price_rules'] loop
    for v_row in select value from jsonb_array_elements(v_expected->v_table) loop
      select string_agg(quote_ident(k), ', ' order by k) into v_columns from jsonb_object_keys(v_row) k;
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) on conflict do nothing',
        v_table, v_columns, v_columns, v_table) using v_row;
    end loop;
  end loop;
  insert into public.offering_resources (business_id, offering_id, resource_id)
  select v_business, (o->>'id')::uuid,
         replace(o->>'id', '00000000010', '00000000020')::uuid
    from jsonb_array_elements(v_expected->'offerings') o
  on conflict (offering_id, resource_id) do nothing;

  -- Preserve ALL existing hours, including deliberately missing days in a partial week.
  -- No resource schedules: engine falls back to the existing business hours.
  insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
  select v_business, d, true, '10:00'::time, '19:00'::time from generate_series(0, 6) d
   where not exists (select 1 from public.business_hours where business_id = v_business)
  on conflict (business_id, day_of_week) do nothing;
  insert into public.business_booking_settings
    (business_id, min_lead_minutes, slot_interval_minutes, max_advance_days, hold_minutes,
     customer_can_cancel, customer_can_reschedule, customer_change_cutoff_hours)
  values (v_business, 15, 60, 30, 10, true, true, 2)
  on conflict (business_id) do nothing;
  insert into public.booking_flows (id, business_id, category, entry, require, optional, "then", options)
  values (v_flow, v_business, null, array['offering'], array['offering','resource','duration','date','time'],
          array[]::text[], array['customer'], '{"show_any_staff":false}'::jsonb)
  on conflict (business_id, category) do nothing;

  if v_new_media is distinct from v_media then
    update public.businesses set media = v_new_media where id = v_business
      and slug = 'jackshop' and kind = 'court' and brand_id = v_brand;
    if not found then raise exception 'Target changed during seed'; end if;
  end if;

  -- Mandatory after-write integrity assertions: exactly 3 fixed offerings, one rate,
  -- one court requirement and one exclusive-capacity court per offering, same tenant.
  foreach v_table in array array['offerings','resources','offering_requirements','price_rules'] loop
    v_count := 0;
    for v_row in select value from jsonb_array_elements(v_expected->v_table) loop
      execute format('select to_jsonb(t) from public.%I t where id = $1 and business_id = $2', v_table)
        into v_existing using (v_row->>'id')::uuid, v_business;
      if v_existing is null or not (v_existing @> v_row)
        or (v_table = 'offerings' and v_existing->'media' <> v_row->'media') then
        raise exception 'Readback failed for % ID %', v_table, v_row->>'id';
      end if;
      v_count := v_count + 1;
    end loop;
    if v_count <> 3 then raise exception 'Readback expected exactly 3 % rows', v_table; end if;
  end loop;
  select count(*) into v_count from public.offerings where business_id = v_business and id = any(v_demo_ids);
  if v_count <> 3 then raise exception 'Expected exactly 3 demo offerings, found %', v_count; end if;
  if (select count(*) from public.price_rules where offering_id = any(v_demo_ids)) <> 3
    or (select count(*) from public.offering_requirements where offering_id = any(v_demo_ids)) <> 3
    or (select count(*) from public.offering_resources l join public.resources r
          on r.id = l.resource_id and r.business_id = l.business_id
         where l.business_id = v_business and l.offering_id = any(v_demo_ids)
           and r.kind = 'court' and r.capacity = 1
           and r.id = replace(l.offering_id::text, '00000000010', '00000000020')::uuid) <> 3 then
    raise exception 'Demo rate / requirement / exclusive court linkage integrity failed';
  end if;
  select media into v_media from public.businesses where id = v_business;
  if v_media is distinct from v_new_media then raise exception 'Gallery readback failed'; end if;

  select * into strict v_flow_row from public.booking_flows where business_id = v_business and category is null;
  if not (v_flow_row.require @> array['offering','resource','duration','date','time']) then
    raise warning 'Existing flow preserved: owner must preview/apply/save resource_slot template or manually require offering, resource, duration, date and time before testing bookings. Seed does NOT certify booking readiness.';
  end if;
  raise notice 'Verified exactly 3 JackShop demo offerings + 3 courts + 3 requirements + 3 hourly rates. Existing flow/settings/hours preserved. Business ID: %', v_business;
end;
$seed$;

-- Human-readable exact-target readback (before COMMIT; errors above abort the entire transaction).
select b.slug, o.id, o.name, p.unit, p.amount, o.min_minutes, o.max_minutes, o.step_minutes,
       r.name as court_name, r.capacity, o.media
from public.businesses b
join public.offerings o on o.business_id = b.id
join public.price_rules p on p.offering_id = o.id and p.business_id = b.id
join public.offering_resources l on l.offering_id = o.id and l.business_id = b.id
join public.resources r on r.id = l.resource_id and r.business_id = b.id
where b.slug = 'jackshop' and b.kind = 'court'
  and b.brand_id = '6ca1c8b4-94cf-4fb8-8f68-38634ec40cb5'
  and o.id in ('7d91c600-74b1-4ac7-9801-000000000101',
               '7d91c600-74b1-4ac7-9801-000000000102',
               '7d91c600-74b1-4ac7-9801-000000000103')
order by o.id;
commit;
