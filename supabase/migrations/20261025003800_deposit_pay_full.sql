-- The customer chooses at booking: pay the deposit or pay in full (docs/LOYALTY_DESIGN.md step 6f).
-- A shop that takes a fixed or percentage deposit may let the customer transfer the whole price instead
-- (deposit_allow_full, on by default). The choice is made when the booking is created; the server then
-- raises that booking's deposit_due to the price, less any points reward set aside for it. Everything
-- after is the same as a deposit: slip, the shop confirms (or the slip check does), the money lands on
-- the bill, and at the visit there is nothing left to pay.
--
--   business_booking_settings.deposit_allow_full   the customer may pay in full instead of the deposit
--   booking_pay_full(booking, discount)            server only: a held booking's due becomes the full price
-- IMPORTANT: run on Kiwmee BEFORE deploying the code. Safe to run again.

alter table public.business_booking_settings add column if not exists deposit_allow_full boolean not null default true;

create or replace function public.booking_pay_full(p_booking_id uuid, p_discount numeric default 0)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_settings public.business_booking_settings%rowtype;
  v_total numeric;
  v_due numeric;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'BK404'; end if;
  select * into v_settings from public.business_booking_settings where business_id = v_booking.business_id;
  if v_booking.status <> 'held' or v_booking.deposit_due is null
     or coalesce(v_settings.deposit_mode, 'none') not in ('fixed', 'percent')
     or not coalesce(v_settings.deposit_allow_full, false) then
    raise exception 'PAY_FULL_UNAVAILABLE' using errcode = 'BK422';
  end if;
  v_total := coalesce((v_booking.price_snapshot->>'total')::numeric, 0);
  v_due := round(greatest(v_total - least(greatest(coalesce(p_discount, 0), 0), v_total), v_booking.deposit_due), 2);
  update public.bookings set deposit_due = v_due where id = p_booking_id;
  return v_due;
end;
$$;

revoke execute on function public.booking_pay_full(uuid, numeric) from public, anon, authenticated;
grant execute on function public.booking_pay_full(uuid, numeric) to service_role;
