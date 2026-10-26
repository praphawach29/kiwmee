-- Customers cancel or move their own booking from the link they get after booking
-- (/b/<slug>/manage/<token>), within the shop's rules (design §10 question 4):
--   customer_can_cancel / customer_can_reschedule   the shop may switch either off
--   customer_change_cutoff_hours                    no later than this many hours before the start
--
-- The link carries a random token; only its sha256 is stored (bookings.manage_token_hash), so the
-- database alone cannot be used to open someone's booking. The public booking API attaches the
-- hash in the same statement that creates the booking (booking_attach_manage_token).
-- Errors use the booking RPC codes: BK404 NOT_FOUND, BK422 CUSTOMER_CHANGE_OFF / TOO_LATE_TO_CHANGE /
-- NOT_CHANGEABLE, and whatever reschedule_booking reports for the new time.
-- Who may call: the service role only (the public API). Shops use cancel_booking / reschedule_booking.

alter table public.business_booking_settings
  add column customer_can_cancel boolean not null default true,
  add column customer_can_reschedule boolean not null default true,
  add column customer_change_cutoff_hours int not null default 2
    check (customer_change_cutoff_hours between 0 and 720);

alter table public.bookings add column manage_token_hash text check (manage_token_hash ~ '^[0-9a-f]{64}$');
create unique index bookings_manage_token_idx on public.bookings(manage_token_hash) where manage_token_hash is not null;

create or replace function public.booking_attach_manage_token(p_booking jsonb, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bookings set manage_token_hash = p_token_hash where id = (p_booking->>'id')::uuid;
  return p_booking;
end;
$$;

-- The customer's booking, locked, once the shop's rules allow p_action ('cancel' | 'reschedule')
create or replace function public.booking_for_customer(p_business_id uuid, p_token_hash text, p_action text)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_allowed boolean;
  v_cutoff int;
begin
  select * into v_booking from public.bookings
   where business_id = p_business_id and manage_token_hash = p_token_hash
   for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if p_action = 'cancel' and v_booking.status = 'cancelled' then
    return v_booking;
  end if;
  if v_booking.status not in ('held','pending','confirmed') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  select case when p_action = 'cancel' then s.customer_can_cancel else s.customer_can_reschedule end,
         s.customer_change_cutoff_hours
    into v_allowed, v_cutoff
    from public.business_booking_settings s where s.business_id = p_business_id;
  if not coalesce(v_allowed, true) then
    raise exception using errcode = 'BK422', message = 'CUSTOMER_CHANGE_OFF';
  end if;
  if now() > v_booking.start_at - make_interval(hours => coalesce(v_cutoff, 2)) then
    raise exception using errcode = 'BK422', message = 'TOO_LATE_TO_CHANGE';
  end if;
  return v_booking;
end;
$$;

create or replace function public.customer_cancel_booking(p_business_id uuid, p_token_hash text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings := public.booking_for_customer(p_business_id, p_token_hash, 'cancel');
begin
  return public.cancel_booking(v_booking.id, 'ลูกค้ายกเลิกเอง' || coalesce(': ' || nullif(trim(p_reason), ''), ''));
end;
$$;

-- The stylist (or court) the customer chose stays the same, as reschedule_booking does
create or replace function public.customer_reschedule_booking(p_business_id uuid, p_token_hash text, p_start_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings := public.booking_for_customer(p_business_id, p_token_hash, 'reschedule');
begin
  return public.reschedule_booking(v_booking.id, p_start_at, null, null, 'web');
end;
$$;

revoke execute on function public.booking_attach_manage_token(jsonb, text) from public, anon, authenticated;
revoke execute on function public.booking_for_customer(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.customer_cancel_booking(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.customer_reschedule_booking(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.booking_attach_manage_token(jsonb, text) to service_role;
grant execute on function public.booking_for_customer(uuid, text, text) to service_role;
grant execute on function public.customer_cancel_booking(uuid, text, text) to service_role;
grant execute on function public.customer_reschedule_booking(uuid, text, timestamptz) to service_role;
