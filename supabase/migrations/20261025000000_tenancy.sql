-- Flexible booking v2, step 1 (docs/FLEXIBLE_BOOKING_DESIGN.md §3, §4.1)
-- Shops (businesses), who may manage them, and the helpers every RLS policy uses.
--
-- Rules for every table in this schema:
--   * a business_id column, RLS on, policies that only reach the caller's own shops
--   * anon reaches nothing directly (public pages go through RPCs, added in later steps)
--   * child rows reference their parent by (id, business_id), so a row can never point
--     at another shop's data even when written by the service role

create extension if not exists btree_gist with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'salon' check (kind in ('salon','barber','spa','court','other')),
  timezone text not null default 'Asia/Bangkok',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger businesses_set_updated_at before update on public.businesses
  for each row execute function public.set_updated_at();

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members(user_id);

-- Membership checks for RLS. security definer so a policy on business_members can ask
-- about business_members without recursing into its own policy.
create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- Signed-in users create a shop through this, which makes them its owner in the same step.
create or replace function public.create_business(p_name text, p_slug text, p_kind text default 'salon')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  insert into public.businesses (name, slug, kind) values (p_name, p_slug, p_kind) returning id into v_id;
  insert into public.business_members (business_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.business_booking_settings (business_id) values (v_id);
  insert into public.booking_flows (business_id) values (v_id);
  return v_id;
end;
$$;

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;

create policy businesses_select on public.businesses
  for select to authenticated using (public.is_business_member(id));
create policy businesses_update on public.businesses
  for update to authenticated using (public.is_business_owner(id)) with check (public.is_business_owner(id));

create policy members_select on public.business_members
  for select to authenticated using (public.is_business_member(business_id));
create policy members_insert on public.business_members
  for insert to authenticated with check (public.is_business_owner(business_id));
create policy members_update on public.business_members
  for update to authenticated using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));
create policy members_delete on public.business_members
  for delete to authenticated using (public.is_business_owner(business_id));

-- Supabase grants every new table and function in public to anon and authenticated directly;
-- revoking from public alone leaves those grants in place. Name the roles.
revoke all on public.businesses, public.business_members from anon;
grant select, update on public.businesses to authenticated;
grant select, insert, update, delete on public.business_members to authenticated;
grant all on public.businesses, public.business_members to service_role;

revoke execute on function public.is_business_member(uuid) from public, anon;
revoke execute on function public.is_business_owner(uuid) from public, anon;
grant execute on function public.is_business_member(uuid) to authenticated, service_role;
grant execute on function public.is_business_owner(uuid) to authenticated, service_role;

revoke execute on function public.create_business(text, text, text) from public, anon;
grant execute on function public.create_business(text, text, text) to authenticated, service_role;
