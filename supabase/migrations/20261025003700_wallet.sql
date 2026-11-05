-- IMPORTANT: run this whole file on booking-v2 (SQL Editor) BEFORE merging the wallet code.
--
-- Kiwmee has no card gateway yet (Omise sign-up is pending), so shops pay by transfer into a Kiwmee
-- account and the money sits in a wallet attached to their brand. Packages and add-ons are then
-- bought from that balance. A top-up is credited automatically when the attached slip passes every
-- check (EasySlip): the amount is really there, it went to Kiwmee's account, the slip is not reused,
-- and it is recent. Anything else stays "pending" for the platform admin to look at.
--
--   wallet_accounts   one balance per brand
--   wallet_entries    append-only ledger; balance_after makes the history auditable
--   wallet_topups     one row per transfer; the slip and what the reader said about it
--   wallet_orders     what was bought from the balance (a plan month, extra messages, extra slip checks)
--   usage_counters    messages sent and slip checks used per brand per month (Bangkok month)
--
-- RLS: members read their brand's wallet; nobody signed in writes. Every write goes through a
-- SECURITY DEFINER function granted to service_role only — the server calls it after checking that
-- the signed-in user owns the brand. Supabase's PostgREST therefore cannot credit a wallet directly.
begin;

create table if not exists public.wallet_accounts (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  balance numeric(12,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_entries (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  kind text not null check (kind in ('topup', 'purchase', 'refund', 'adjust')),
  amount numeric(12,2) not null check (amount <> 0),
  balance_after numeric(12,2) not null check (balance_after >= 0),
  ref_type text check (ref_type is null or ref_type in ('topup', 'order', 'manual')),
  ref_id uuid,
  note text check (note is null or length(note) <= 300),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists wallet_entries_brand_idx on public.wallet_entries(brand_id, created_at desc);

create table if not exists public.wallet_topups (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  amount numeric(12,2) not null check (amount between 100 and 20000),   -- what the shop says it sent
  status text not null default 'pending' check (status in ('pending', 'credited', 'rejected', 'expired')),
  slip bytea check (slip is null or octet_length(slip) between 1 and 1572864),
  mime text default 'image/webp' check (mime = 'image/webp'),
  check_status text check (check_status in ('passed', 'failed', 'error')),
  check_reasons text[] not null default '{}',
  trans_ref text,
  receiver_text text,
  credit_amount numeric(12,2) check (credit_amount is null or credit_amount > 0),
  credited_at timestamptz,
  reviewed_by uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists wallet_topups_trans_ref_idx on public.wallet_topups(trans_ref) where trans_ref is not null;
create index if not exists wallet_topups_brand_idx on public.wallet_topups(brand_id, created_at desc);

create table if not exists public.wallet_orders (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  sku text not null check (length(sku) between 2 and 40),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists wallet_orders_brand_idx on public.wallet_orders(brand_id, created_at desc);

create table if not exists public.usage_counters (
  brand_id uuid not null references public.brands(id) on delete cascade,
  period date not null,                       -- first day of the Bangkok month
  messages_used int not null default 0 check (messages_used >= 0),
  messages_included int not null default 0 check (messages_included >= 0),
  messages_purchased int not null default 0 check (messages_purchased >= 0),
  slips_used int not null default 0 check (slips_used >= 0),
  updated_at timestamptz not null default now(),
  primary key (brand_id, period)
);

alter table public.wallet_accounts enable row level security;
alter table public.wallet_entries enable row level security;
alter table public.wallet_topups enable row level security;
alter table public.wallet_orders enable row level security;
alter table public.usage_counters enable row level security;

create policy wallet_accounts_select on public.wallet_accounts for select to authenticated using (public.is_brand_member(brand_id));
create policy wallet_entries_select on public.wallet_entries for select to authenticated using (public.is_brand_member(brand_id));
create policy wallet_topups_select on public.wallet_topups for select to authenticated using (public.is_brand_member(brand_id));
create policy wallet_orders_select on public.wallet_orders for select to authenticated using (public.is_brand_member(brand_id));
create policy usage_counters_select on public.usage_counters for select to authenticated using (public.is_brand_member(brand_id));

revoke all on public.wallet_accounts, public.wallet_entries, public.wallet_topups, public.wallet_orders, public.usage_counters from anon, authenticated;
grant select on public.wallet_accounts, public.wallet_entries, public.wallet_topups, public.wallet_orders, public.usage_counters to authenticated;
grant all on public.wallet_accounts, public.wallet_entries, public.wallet_topups, public.wallet_orders, public.usage_counters to service_role;

-- Credit a top-up exactly once. Re-running on a credited top-up returns the current balance.
create or replace function public.wallet_apply_topup(
  p_topup_id uuid,
  p_amount numeric,
  p_trans_ref text,
  p_receiver text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup public.wallet_topups;
  v_balance numeric(12,2);
begin
  select * into v_topup from public.wallet_topups where id = p_topup_id for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_topup.status = 'credited' then
    select balance into v_balance from public.wallet_accounts where brand_id = v_topup.brand_id;
    return jsonb_build_object('status', 'credited', 'balance', coalesce(v_balance, 0), 'already', true);
  end if;
  if v_topup.status <> 'pending' then
    raise exception using errcode = 'BK422', message = 'NOT_PENDING';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
  end if;

  insert into public.wallet_accounts (brand_id) values (v_topup.brand_id) on conflict (brand_id) do nothing;
  update public.wallet_accounts
     set balance = balance + p_amount, updated_at = now()
   where brand_id = v_topup.brand_id
   returning balance into v_balance;

  update public.wallet_topups
     set status = 'credited', credited_at = now(), credit_amount = p_amount,
         trans_ref = coalesce(wallet_topups.trans_ref, p_trans_ref),
         receiver_text = coalesce(p_receiver, wallet_topups.receiver_text)
   where id = p_topup_id;

  insert into public.wallet_entries (brand_id, kind, amount, balance_after, ref_type, ref_id, note, created_by)
  values (v_topup.brand_id, 'topup', p_amount, v_balance, 'topup', p_topup_id, 'เติมเงิน', v_topup.created_by);

  return jsonb_build_object('status', 'credited', 'balance', v_balance, 'already', false);
end;
$$;

-- Take money for a package or add-on. Fails with BK422 / INSUFFICIENT_BALANCE when the wallet is short.
create or replace function public.wallet_charge(
  p_brand_id uuid,
  p_amount numeric,
  p_kind text,
  p_ref uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(12,2);
begin
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
  end if;
  select balance into v_balance from public.wallet_accounts where brand_id = p_brand_id for update;
  if v_balance is null or v_balance < p_amount then
    raise exception using errcode = 'BK422', message = 'INSUFFICIENT_BALANCE';
  end if;
  update public.wallet_accounts
     set balance = balance - p_amount, updated_at = now()
   where brand_id = p_brand_id
   returning balance into v_balance;
  insert into public.wallet_entries (brand_id, kind, amount, balance_after, ref_type, ref_id, note)
  values (p_brand_id, 'purchase', -p_amount, v_balance, 'order', p_ref, left(coalesce(p_note, p_kind), 300));
  return jsonb_build_object('balance', v_balance);
end;
$$;

-- Count what a brand used this month: messages sent, messages bought, slip checks used.
create or replace function public.usage_add(
  p_brand_id uuid,
  p_messages int default 0,
  p_slips int default 0,
  p_included int default 0,
  p_purchased int default 0
)
returns public.usage_counters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.usage_counters;
  v_period date := date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date;
begin
  insert into public.usage_counters as u (brand_id, period, messages_used, messages_included, messages_purchased, slips_used)
  values (p_brand_id, v_period, greatest(coalesce(p_messages, 0), 0), greatest(coalesce(p_included, 0), 0),
          greatest(coalesce(p_purchased, 0), 0), greatest(coalesce(p_slips, 0), 0))
  on conflict (brand_id, period) do update
     set messages_used = u.messages_used + greatest(coalesce(p_messages, 0), 0),
         messages_included = greatest(u.messages_included, greatest(coalesce(p_included, 0), 0)),
         messages_purchased = u.messages_purchased + greatest(coalesce(p_purchased, 0), 0),
         slips_used = u.slips_used + greatest(coalesce(p_slips, 0), 0),
         updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.wallet_apply_topup(uuid, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.wallet_charge(uuid, numeric, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.usage_add(uuid, int, int, int, int) from public, anon, authenticated;
grant execute on function public.wallet_apply_topup(uuid, numeric, text, text) to service_role;
grant execute on function public.wallet_charge(uuid, numeric, text, uuid, text) to service_role;
grant execute on function public.usage_add(uuid, int, int, int, int) to service_role;

commit;
