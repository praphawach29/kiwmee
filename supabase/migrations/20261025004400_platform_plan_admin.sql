-- B7 (docs/BILLING_PLAN.md 3.6): the platform admin sets a brand's plan and corrects its wallet from
-- /super instead of SQL, and every such change is written down with who and why.
--
--   platform_plan_changes  one row per change: brand, admin, action, before/after, reason
--   wallet_adjust()        add or take back money (kind 'adjust'), never below zero
-- Both only for the server's own connection (service_role / owner): the server checks the person is in
-- platform_admins first (src/v2/platform-plans.js).

create table if not exists public.platform_plan_changes (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  admin_id uuid,
  action text not null check (action in ('set_plan', 'adjust_wallet')),
  detail jsonb not null default '{}'::jsonb,
  reason text not null check (length(trim(reason)) between 3 and 300),
  created_at timestamptz not null default now()
);
create index if not exists platform_plan_changes_brand_idx on public.platform_plan_changes(brand_id, created_at desc);
alter table public.platform_plan_changes enable row level security;
revoke all on public.platform_plan_changes from anon, authenticated;
grant all on public.platform_plan_changes to service_role;

create or replace function public.wallet_adjust(p_brand_id uuid, p_amount numeric, p_note text, p_admin uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(12,2);
begin
  if p_amount is null or p_amount = 0 or abs(p_amount) > 100000 then
    raise exception using errcode = 'BK422', message = 'INVALID_AMOUNT';
  end if;
  insert into public.wallet_accounts (brand_id) values (p_brand_id) on conflict (brand_id) do nothing;
  select balance into v_balance from public.wallet_accounts where brand_id = p_brand_id for update;
  if v_balance + p_amount < 0 then
    raise exception using errcode = 'BK422', message = 'INSUFFICIENT_BALANCE';
  end if;
  update public.wallet_accounts set balance = balance + p_amount, updated_at = now()
   where brand_id = p_brand_id returning balance into v_balance;
  insert into public.wallet_entries (brand_id, kind, amount, balance_after, ref_type, note, created_by)
  values (p_brand_id, 'adjust', p_amount, v_balance, 'manual', left(coalesce(p_note, 'ปรับยอดโดยทีมงาน'), 300), p_admin);
  return jsonb_build_object('balance', v_balance);
end;
$$;
revoke execute on function public.wallet_adjust(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.wallet_adjust(uuid, numeric, text, uuid) to service_role;
