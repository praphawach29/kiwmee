-- Slips checked automatically (docs/LOYALTY_DESIGN.md step 6f: v1's slip checking, moved to v2).
-- When the platform has an EasySlip key (set in /super), every slip a customer sends is read by the
-- bank-slip service: how much, to whom, when, and its transfer reference. The shop sees the result next
-- to the slip. A shop may let a slip that passes every check confirm the deposit by itself
-- (slip_auto_confirm, off by default: the reading service is a helper, not the bank).
--
--   payment_slips.check_status   null (not checked: no key) · passed · failed · error (the service failed)
--   payment_slips.check_reasons  what failed: AMOUNT_LOW · RECEIVER_MISMATCH · RECEIVER_UNKNOWN · TOO_EARLY
--                                · DUPLICATE · UNREADABLE
--   payment_slips.trans_ref      the bank's transfer reference: a slip that passed cannot pass again anywhere
-- Only the server writes these (slip_record_check). Members read them as before; anon nothing.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code. Safe to run again.

alter table public.payment_slips add column if not exists check_status text;
alter table public.payment_slips drop constraint if exists payment_slips_check_status_check;
alter table public.payment_slips add constraint payment_slips_check_status_check check (check_status is null or check_status in ('passed', 'failed', 'error'));
alter table public.payment_slips add column if not exists check_reasons text[] not null default '{}';
alter table public.payment_slips add column if not exists trans_ref text check (trans_ref is null or length(trans_ref) <= 80);
alter table public.payment_slips add column if not exists paid_amount numeric(12,2);
alter table public.payment_slips add column if not exists paid_at timestamptz;
alter table public.payment_slips add column if not exists receiver text check (receiver is null or length(receiver) <= 200);
alter table public.payment_slips add column if not exists checked_at timestamptz;
create unique index if not exists payment_slips_trans_ref_passed on public.payment_slips(trans_ref) where check_status = 'passed';
create index if not exists payment_slips_trans_ref_idx on public.payment_slips(trans_ref) where trans_ref is not null;

alter table public.business_booking_settings add column if not exists slip_auto_confirm boolean not null default false;

-- The server records what the reading service said (and whether this reference was seen before)
create or replace function public.slip_record_check(
  p_slip_id uuid, p_status text, p_reasons text[], p_trans_ref text, p_amount numeric, p_paid_at timestamptz, p_receiver text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := p_status;
  v_reasons text[] := coalesce(p_reasons, '{}');
begin
  -- a transfer reference already used by another slip: the same transfer cannot pay twice
  if p_trans_ref is not null and exists (select 1 from public.payment_slips where trans_ref = p_trans_ref and id <> p_slip_id) then
    v_status := 'failed';
    if not ('DUPLICATE' = any(v_reasons)) then v_reasons := array_append(v_reasons, 'DUPLICATE'); end if;
  end if;
  update public.payment_slips
     set check_status = v_status, check_reasons = v_reasons, trans_ref = left(p_trans_ref, 80), paid_amount = p_amount,
         paid_at = p_paid_at, receiver = left(p_receiver, 200), checked_at = now()
   where id = p_slip_id;
  return v_status;
end;
$$;

revoke execute on function public.slip_record_check(uuid, text, text[], text, numeric, timestamptz, text) from public, anon, authenticated;
grant execute on function public.slip_record_check(uuid, text, text[], text, numeric, timestamptz, text) to service_role;
