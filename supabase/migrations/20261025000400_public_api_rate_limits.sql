-- Flexible booking v2, step 4: rate limits for the public booking API (app/api/b/*)
-- The booking page is open to anyone, so the API counts requests per client in the database
-- (serverless instances do not share memory). Only the server-side API uses this.

create table public.api_rate_limits (
  key_hash text not null,
  window_start timestamptz not null,
  count int not null default 1,
  primary key (key_hash, window_start)
);
create index api_rate_limits_window_idx on public.api_rate_limits(window_start);

alter table public.api_rate_limits enable row level security;   -- no policies: nobody but the server
revoke all on public.api_rate_limits from anon, authenticated;
grant all on public.api_rate_limits to service_role;

-- true = allowed. Fixed windows; old windows are cleaned up as new ones start.
create or replace function public.hit_rate_limit(p_key_hash text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count int;
begin
  insert into public.api_rate_limits (key_hash, window_start) values (p_key_hash, v_window)
  on conflict (key_hash, window_start) do update set count = public.api_rate_limits.count + 1
  returning count into v_count;
  if v_count = 1 and random() < 0.05 then
    delete from public.api_rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_count <= p_max;
end;
$$;

revoke execute on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;
