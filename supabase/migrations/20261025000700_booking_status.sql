-- Shop bookings page (app/dashboard, "การจอง"): the shop marks what happened to a booking.
-- create / reschedule / cancel already have RPCs (…000300); this adds the day-of-visit steps.
--
--   confirmed / pending  → checked_in (มาถึงแล้ว) · completed (เสร็จแล้ว) · no_show (ไม่มา)
--   checked_in           → completed · confirmed (undo)
--   completed            → checked_in (undo)
-- no_show releases the slot (bookings_release_resources), so it cannot be undone here: the
-- slot may already be someone else's. The status history trigger records who and why.

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
  perform set_config('booking.status_reason', coalesce(p_reason, ''), true);
  update public.bookings set status = p_status, hold_expires_at = null where id = p_booking_id;
  perform set_config('booking.status_reason', '', true);
  return public.booking_result(p_booking_id);
end;
$$;

revoke execute on function public.set_booking_status(uuid, text, text) from public, anon;
grant execute on function public.set_booking_status(uuid, text, text) to authenticated, service_role;
