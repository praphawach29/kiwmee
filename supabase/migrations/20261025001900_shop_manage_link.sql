-- The shop sends the customer their own booking link (/b/<slug>/manage/<token>) for a booking
-- it took by phone or at the desk, or again for any upcoming booking (roadmap Phase 0, 3.6).
--
-- Only the token's sha256 is stored (migration …000900), so a link can never be shown twice: issuing
-- one replaces the booking's hash, and any earlier link for that booking stops working. The app
-- makes the token, keeps it only long enough to show the shop, and passes its hash here.
--
-- Who may call: a member of the booking's shop (owner or staff), signed in. Only bookings that can
-- still change (held, pending, confirmed) get a link. Errors: BK404 NOT_FOUND (no such booking, or
-- another shop's), BK422 NOT_CHANGEABLE, 22023 for a malformed hash.

create or replace function public.issue_manage_link(p_booking_id uuid, p_token_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid token hash' using errcode = '22023';
  end if;
  select * into v_booking from public.bookings where id = p_booking_id for update;
  -- another shop's booking looks the same as a missing one
  if not found or not public.is_business_member(v_booking.business_id) then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_booking.status not in ('held', 'pending', 'confirmed') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  update public.bookings set manage_token_hash = p_token_hash where id = p_booking_id;
end;
$$;

revoke execute on function public.issue_manage_link(uuid, text) from public, anon;
grant execute on function public.issue_manage_link(uuid, text) to authenticated, service_role;
