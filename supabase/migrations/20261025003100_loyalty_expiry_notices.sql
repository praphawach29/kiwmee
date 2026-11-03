-- "Your points run out soon" LINE cards (docs/LOYALTY_DESIGN.md §4: a card 14 days before points expire).
-- One row per member, brand and expiry day: it is claimed before the card is sent, so a member hears
-- about the same day once, however many servers run the loop. The brand's shops can see who was told;
-- only the server writes. IMPORTANT: run on booking-v2 BEFORE deploying the code. Safe to run again.

create table if not exists public.loyalty_expiry_notices (
  brand_id uuid not null references public.brands(id) on delete cascade,
  line_user_id text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  expires_on date not null,
  points int not null default 0,
  result text check (result is null or length(result) <= 40),
  created_at timestamptz not null default now(),
  primary key (brand_id, line_user_id, expires_on)
);

alter table public.loyalty_expiry_notices enable row level security;
drop policy if exists loyalty_expiry_notices_select on public.loyalty_expiry_notices;
create policy loyalty_expiry_notices_select on public.loyalty_expiry_notices for select to authenticated using (public.is_brand_member(brand_id));
revoke all on public.loyalty_expiry_notices from anon;
revoke all on public.loyalty_expiry_notices from authenticated;
grant select on public.loyalty_expiry_notices to authenticated;
grant all on public.loyalty_expiry_notices to service_role;

-- ---------- the balance: a fixed order for entries made at the same moment ----------
create or replace function public.loyalty_balance(p_brand_id uuid, p_line_user_id text, p_now timestamptz default now())
returns table (balance int, expiring int, expiring_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row record;
  v_exp timestamptz[] := '{}';
  v_rem int[] := '{}';
  v_debt int := 0;
  v_need int;
  v_pick int;
  v_take int;
  i int;
begin
  if auth.uid() is not null and not public.is_brand_member(p_brand_id) then
    raise exception 'not a member of this brand' using errcode = '42501';
  end if;
  for v_row in
    select l.points, l.expires_at, l.created_at from public.loyalty_ledger l
     where l.brand_id = p_brand_id and l.line_user_id = p_line_user_id
     -- entries of one transaction share a time: points in before points out, so a reward used on the
     -- bill that also earns is taken from the soonest-expiring points, not the ones just earned
     order by l.created_at, (l.points < 0), l.id
  loop
    -- lots that ran out before this entry are gone
    for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
      if v_exp[i] is not null and v_exp[i] <= v_row.created_at then v_rem[i] := 0; end if;
    end loop;
    if v_row.points > 0 then
      v_take := least(v_debt, v_row.points);          -- a debt is paid first
      v_debt := v_debt - v_take;
      if v_row.points - v_take > 0 then
        v_exp := v_exp || v_row.expires_at;
        v_rem := v_rem || (v_row.points - v_take);
      end if;
    else
      v_need := -v_row.points;
      while v_need > 0 loop
        v_pick := null;
        for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
          if v_rem[i] > 0 and (v_pick is null
               or (v_exp[i] is not null and (v_exp[v_pick] is null or v_exp[i] < v_exp[v_pick]))) then
            v_pick := i;
          end if;
        end loop;
        exit when v_pick is null;
        v_take := least(v_need, v_rem[v_pick]);
        v_rem[v_pick] := v_rem[v_pick] - v_take;
        v_need := v_need - v_take;
      end loop;
      v_debt := v_debt + v_need;
    end if;
  end loop;

  balance := 0; expiring := 0; expiring_at := null;
  for i in 1 .. coalesce(array_length(v_rem, 1), 0) loop
    if v_exp[i] is null or v_exp[i] > p_now then
      balance := balance + v_rem[i];
      -- what runs out within 30 days
      if v_rem[i] > 0 and v_exp[i] is not null and v_exp[i] <= p_now + interval '30 days' then
        expiring := expiring + v_rem[i];
        expiring_at := least(coalesce(expiring_at, v_exp[i]), v_exp[i]);
      end if;
    end if;
  end loop;
  balance := balance - v_debt;
  return next;
end;
$$;

revoke execute on function public.loyalty_balance(uuid, text, timestamptz) from public, anon;
grant execute on function public.loyalty_balance(uuid, text, timestamptz) to authenticated, service_role;
