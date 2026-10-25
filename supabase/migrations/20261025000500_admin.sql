-- Flexible booking v2, step 5: the shop admin (app/dashboard, docs/FLEXIBLE_BOOKING_DESIGN.md §9)
-- Owners sign in with Supabase Auth and edit their catalog through the server, which runs each
-- request as role `authenticated` with the user's id, so the step 1 RLS policies decide what
-- they may read and change. This file only fills the gaps the admin needs.

-- 1. A new shop starts with opening hours on every day (10–19, the default the options engine and
--    booking_plan already assume), so the hours page shows real rows the owner can change.
create or replace function public.create_business(p_name text, p_slug text, p_kind text default 'salon')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  insert into public.businesses (name, slug, kind) values (p_name, p_slug, p_kind) returning id into v_id;
  insert into public.business_members (business_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.business_booking_settings (business_id) values (v_id);
  insert into public.booking_flows (business_id) values (v_id);
  insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
  select v_id, d, true, '10:00', '19:00' from generate_series(0, 6) d;
  return v_id;
end;
$$;

revoke execute on function public.create_business(text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text) to authenticated, service_role;

-- 2. Shops created before this migration that never had hours saved get the same rows
insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
select b.id, d, true, '10:00', '19:00'
from public.businesses b cross join generate_series(0, 6) d
where not exists (select 1 from public.business_hours h where h.business_id = b.id)
on conflict do nothing;
