-- Test-only stand-in for what a Supabase project already has, so the migrations can run on a
-- plain local Postgres (scripts/db-test.sh). Never applied to a real Supabase project.
--
-- Mirrors the parts the migrations rely on:
--   * roles anon / authenticated / service_role (service_role bypasses RLS)
--   * auth.users and auth.uid(), read from the request's JWT claims as PostgREST sets them
--   * Supabase's default privileges: every new table and function in public is granted to
--     anon, authenticated and service_role directly. This is what makes "revoke … from public"
--     not enough on a real project, so the tests must start from the same grants.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists extensions;   -- where Supabase installs extensions
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
