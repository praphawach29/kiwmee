-- Shop team (docs/SALES_READINESS_ROADMAP.md Phase 0): owners invite staff or co-owners by email,
-- change their role and remove them, without SQL. Kiwmee sends no email itself: the owner tells
-- the person to sign in at /dashboard with that address, and the invite is taken up then.
--
--   business_invites   pending invites (one open invite per shop and email)
--   invite_member      adds an existing account at once, otherwise leaves an invite
--   accept_my_invites  run at sign-in: invites for the caller's *confirmed* email become memberships
--   shop_team          members (with email) and open invites, for the shop's owners
--   set_member_role / remove_member / cancel_invite
--
-- A shop always keeps at least one owner. Errors: BK404 NOT_FOUND, BK422 INVALID_EMAIL /
-- ALREADY_MEMBER / LAST_OWNER / INVALID_ROLE. Only owners call these (42501 otherwise).

create table public.business_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('owner','staff')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid
);
create unique index business_invites_open_idx on public.business_invites(business_id, email) where accepted_at is null;
create index business_invites_email_idx on public.business_invites(email) where accepted_at is null;

alter table public.business_invites enable row level security;
create policy business_invites_select on public.business_invites for select to authenticated
  using (public.is_business_owner(business_id));
revoke all on public.business_invites from anon;
revoke insert, update, delete, truncate on public.business_invites from authenticated;
grant select on public.business_invites to authenticated;
grant all on public.business_invites to service_role;

create or replace function public.team_assert_owner(p_business_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.businesses where id = p_business_id) then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if auth.uid() is not null and not public.is_business_owner(p_business_id) then
    raise exception 'only the shop owner can manage the team' using errcode = '42501';
  end if;
end;
$$;

-- An existing account is added straight away; anyone else gets an invite for when they sign up
create or replace function public.invite_member(p_business_id uuid, p_email text, p_role text default 'staff')
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user uuid;
  v_id uuid;
begin
  perform public.team_assert_owner(p_business_id);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception using errcode = 'BK422', message = 'INVALID_EMAIL';
  end if;
  if p_role is null or p_role not in ('owner','staff') then
    raise exception using errcode = 'BK422', message = 'INVALID_ROLE';
  end if;

  select u.id into v_user from auth.users u where lower(u.email) = v_email limit 1;
  if v_user is not null then
    if exists (select 1 from public.business_members where business_id = p_business_id and user_id = v_user) then
      raise exception using errcode = 'BK422', message = 'ALREADY_MEMBER';
    end if;
    insert into public.business_members (business_id, user_id, role) values (p_business_id, v_user, p_role);
    return jsonb_build_object('status', 'added', 'email', v_email, 'role', p_role);
  end if;

  insert into public.business_invites (business_id, email, role, invited_by)
  values (p_business_id, v_email, p_role, auth.uid())
  on conflict (business_id, email) where accepted_at is null
  do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now()
  returning id into v_id;
  return jsonb_build_object('status', 'invited', 'id', v_id, 'email', v_email, 'role', p_role);
end;
$$;

-- At sign-in: open invites for the caller's email become memberships. The email must be one
-- Supabase Auth has confirmed, so nobody takes an invite by signing up with someone else's address.
create or replace function public.accept_my_invites()
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
  v_count int := 0;
  v_invite record;
begin
  if auth.uid() is null then
    return 0;
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;
  for v_invite in
    select * from public.business_invites where email = v_email and accepted_at is null for update
  loop
    insert into public.business_members (business_id, user_id, role)
    values (v_invite.business_id, auth.uid(), v_invite.role)
    on conflict (business_id, user_id) do nothing;
    update public.business_invites set accepted_at = now(), accepted_by = auth.uid() where id = v_invite.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Members with their email, and open invites
create or replace function public.shop_team(p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  perform public.team_assert_owner(p_business_id);
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'since', m.created_at,
                                          'brand_owner', exists (select 1 from public.businesses b join public.brand_members bm
                                                                   on bm.brand_id = b.brand_id
                                                                  where b.id = p_business_id and bm.user_id = m.user_id))
                       order by m.role, u.email)
        from public.business_members m left join auth.users u on u.id = m.user_id
       where m.business_id = p_business_id), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'created_at', i.created_at) order by i.created_at)
        from public.business_invites i
       where i.business_id = p_business_id and i.accepted_at is null), '[]'::jsonb)
  );
end;
$$;

create or replace function public.team_other_owner_exists(p_business_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.business_members
                  where business_id = p_business_id and role = 'owner' and user_id <> p_user_id);
$$;

create or replace function public.set_member_role(p_business_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  perform public.team_assert_owner(p_business_id);
  if p_role is null or p_role not in ('owner','staff') then
    raise exception using errcode = 'BK422', message = 'INVALID_ROLE';
  end if;
  select role into v_role from public.business_members where business_id = p_business_id and user_id = p_user_id for update;
  if v_role is null then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_role = 'owner' and p_role <> 'owner' and not public.team_other_owner_exists(p_business_id, p_user_id) then
    raise exception using errcode = 'BK422', message = 'LAST_OWNER';
  end if;
  update public.business_members set role = p_role where business_id = p_business_id and user_id = p_user_id;
end;
$$;

create or replace function public.remove_member(p_business_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  perform public.team_assert_owner(p_business_id);
  select role into v_role from public.business_members where business_id = p_business_id and user_id = p_user_id for update;
  if v_role is null then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_role = 'owner' and not public.team_other_owner_exists(p_business_id, p_user_id) then
    raise exception using errcode = 'BK422', message = 'LAST_OWNER';
  end if;
  delete from public.business_members where business_id = p_business_id and user_id = p_user_id;
end;
$$;

create or replace function public.cancel_invite(p_business_id uuid, p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.team_assert_owner(p_business_id);
  delete from public.business_invites where id = p_invite_id and business_id = p_business_id and accepted_at is null;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
end;
$$;

revoke execute on function public.team_assert_owner(uuid) from public, anon, authenticated;
revoke execute on function public.team_other_owner_exists(uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_assert_owner(uuid) to service_role;
grant execute on function public.team_other_owner_exists(uuid, uuid) to service_role;
revoke execute on function public.invite_member(uuid, text, text) from public, anon;
revoke execute on function public.accept_my_invites() from public, anon;
revoke execute on function public.shop_team(uuid) from public, anon;
revoke execute on function public.set_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
revoke execute on function public.cancel_invite(uuid, uuid) from public, anon;
grant execute on function public.invite_member(uuid, text, text) to authenticated, service_role;
grant execute on function public.accept_my_invites() to authenticated, service_role;
grant execute on function public.shop_team(uuid) to authenticated, service_role;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.cancel_invite(uuid, uuid) to authenticated, service_role;
