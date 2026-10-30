-- Platform settings and super admins (the LINE keys of step 6a, set from /super instead of in code).
--
--   platform_admins     who may open /super (Kiwmee's own staff); filled by SQL, see supabase/README.md
--   platform_settings   key -> value. Secrets are stored encrypted by the app (AES-GCM, SETTINGS_ENCRYPTION_KEY);
--                       the database never sees the plain secret and never returns it
--
-- Nobody but the server (service role / database owner) touches the tables. Signed-in users reach them
-- only through the functions below, which refuse anyone who is not in platform_admins (SQLSTATE 42501).
-- The list function hides the value of secrets, and there is no function that reads one back.

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  value text not null check (length(value) between 1 and 4000),
  is_secret boolean not null default false,
  hint text check (hint is null or length(hint) <= 20),   -- e.g. the last 4 characters of a secret, so an admin can tell which one is set
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
alter table public.platform_settings enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;
revoke all on public.platform_settings from public, anon, authenticated;
grant select on public.platform_admins to service_role;
grant select, insert, update, delete on public.platform_settings to service_role;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.platform_assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
end;
$$;

-- Every setting except the value of secrets
create or replace function public.platform_settings_list()
returns table (key text, is_secret boolean, value text, hint text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.platform_assert_admin();
  return query
    select s.key, s.is_secret, case when s.is_secret then null else s.value end, s.hint, s.updated_at
      from public.platform_settings s order by s.key;
end;
$$;

create or replace function public.platform_setting_set(p_key text, p_value text, p_is_secret boolean, p_hint text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.platform_assert_admin();
  insert into public.platform_settings (key, value, is_secret, hint, updated_by)
  values (p_key, p_value, coalesce(p_is_secret, false), case when p_is_secret then p_hint end, auth.uid())
  on conflict (key) do update
    set value = excluded.value, is_secret = excluded.is_secret, hint = excluded.hint,
        updated_by = excluded.updated_by, updated_at = now();
end;
$$;

create or replace function public.platform_setting_clear(p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.platform_assert_admin();
  delete from public.platform_settings where key = p_key;
end;
$$;

revoke execute on function public.is_platform_admin() from public, anon;
revoke execute on function public.platform_assert_admin() from public, anon, authenticated;
revoke execute on function public.platform_settings_list() from public, anon;
revoke execute on function public.platform_setting_set(text, text, boolean, text) from public, anon;
revoke execute on function public.platform_setting_clear(text) from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.platform_settings_list() to authenticated, service_role;
grant execute on function public.platform_setting_set(text, text, boolean, text) to authenticated, service_role;
grant execute on function public.platform_setting_clear(text) to authenticated, service_role;
