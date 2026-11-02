-- Booking activity (docs/SALES_READINESS_ROADMAP.md Phase 0): the shop sees what changed and who did
-- it — a new booking, a customer moving or cancelling theirs — with an unread count per member.
-- Moves were not recorded anywhere before (booking_status_history only holds status changes).
--
--   booking_events          one row per booking created / moved / status change, written by a trigger
--                           on bookings, so every path (booking page, customer link, shop, holds) is covered
--   actor                   customer = no signed-in user (the public booking API and the customer link),
--                           shop = a signed-in member, system = a hold that ran out
--   business_members.activity_seen_at   where each member last looked; newer customer events are unread
--   mark_activity_seen(shop)            moves the caller's marker to now
-- LINE notifications (Phase 1) will read the same table.

create table public.booking_events (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  booking_id uuid not null,
  kind text not null check (kind in ('created','rescheduled','cancelled','status')),
  actor text not null check (actor in ('customer','shop','system')),
  status text,                                  -- the booking's status after the change
  from_start timestamptz,                       -- rescheduled: where it was
  to_start timestamptz,                         -- created / rescheduled: where it is now
  reason text,
  created_at timestamptz not null default now(),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade
);
create index booking_events_business_created_idx on public.booking_events(business_id, created_at desc);
create index booking_events_booking_idx on public.booking_events(booking_id);

alter table public.business_members add column activity_seen_at timestamptz not null default now();

create or replace function public.bookings_log_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(current_setting('booking.status_reason', true), '');
  v_actor text := case when auth.uid() is null then 'customer' else 'shop' end;
begin
  if tg_op = 'INSERT' then
    insert into public.booking_events (business_id, booking_id, kind, actor, status, to_start, reason)
    values (new.business_id, new.id, 'created',
            case when new.source = 'admin' then 'shop' else v_actor end,
            new.status, new.start_at, v_reason);
    return new;
  end if;

  if new.start_at is distinct from old.start_at then
    insert into public.booking_events (business_id, booking_id, kind, actor, status, from_start, to_start)
    values (new.business_id, new.id, 'rescheduled', v_actor, new.status, old.start_at, new.start_at);
  end if;
  if new.status is distinct from old.status then
    insert into public.booking_events (business_id, booking_id, kind, actor, status, reason)
    values (new.business_id, new.id,
            case when new.status = 'cancelled' then 'cancelled' else 'status' end,
            case when new.status = 'expired' then 'system' else v_actor end,
            new.status, v_reason);
  end if;
  return new;
end;
$$;
create trigger bookings_log_event after insert or update of start_at, status on public.bookings
  for each row execute function public.bookings_log_event();

-- Members read their shop's activity; only the trigger writes it
alter table public.booking_events enable row level security;
create policy booking_events_select on public.booking_events for select to authenticated
  using (public.is_business_member(business_id));
revoke all on public.booking_events from anon;
revoke insert, update, delete, truncate on public.booking_events from authenticated;
grant select on public.booking_events to authenticated;
grant all on public.booking_events to service_role;

create or replace function public.mark_activity_seen(p_business_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at timestamptz := now();
begin
  update public.business_members set activity_seen_at = v_at
   where business_id = p_business_id and user_id = auth.uid();
  if not found then
    raise exception 'not a member of this shop' using errcode = '42501';
  end if;
  return v_at;
end;
$$;

revoke execute on function public.bookings_log_event() from public, anon, authenticated;
revoke execute on function public.mark_activity_seen(uuid) from public, anon;
grant execute on function public.mark_activity_seen(uuid) to authenticated, service_role;
