-- Appointment reminders in LINE (docs/LOYALTY_DESIGN.md 6a): customers who booked inside LINE get a
-- card the day before (24 hours) and again 2 hours before, through Kiwmee's OA. The app's server
-- looks for due reminders every few minutes (src/v2/line-reminders.js).
--
--   business_booking_settings.line_reminders   the shop can switch them off (default on)
--   bookings.line_manage_token                 the customer's own booking link, encrypted by the app
--                                              (SETTINGS_ENCRYPTION_KEY), so a reminder can carry it;
--                                              only the hash is used to open the booking
--   booking_reminders                          one row per sent (or tried) reminder: never twice;
--                                              members read, only the server writes
-- Moving a booking clears its reminders, so the new time is reminded again.

alter table public.business_booking_settings add column line_reminders boolean not null default true;

alter table public.bookings add column line_manage_token text check (line_manage_token is null or length(line_manage_token) <= 400);

create table public.booking_reminders (
  business_id uuid not null,
  booking_id uuid not null,
  kind text not null check (kind in ('day','soon')),
  created_at timestamptz not null default now(),
  result text check (result is null or length(result) <= 40),   -- sent / LINE_REFUSED / NO_TOKEN ...
  primary key (booking_id, kind),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade
);

alter table public.booking_reminders enable row level security;
create policy booking_reminders_select on public.booking_reminders for select to authenticated using (public.is_business_member(business_id));
revoke all on public.booking_reminders from anon;
revoke insert, update, delete, truncate on public.booking_reminders from authenticated;
grant select on public.booking_reminders to authenticated;
grant all on public.booking_reminders to service_role;

create or replace function public.booking_reminders_reset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.booking_reminders where booking_id = new.id;
  return new;
end;
$$;

create trigger bookings_reminders_reset after update of start_at on public.bookings
  for each row when (new.start_at is distinct from old.start_at)
  execute function public.booking_reminders_reset();

revoke execute on function public.booking_reminders_reset() from public, anon, authenticated;
