-- Rental documents (docs/FLEXIBLE_BOOKING_DESIGN.md 11.7, stage E3): a shop that lends out cars or
-- cameras can ask the customer for a photo of their ID card / driving licence / passport. This is
-- personal data under the PDPA, so:
--
--   * the customer agrees first (consent_at is kept with the document), on their own booking link;
--   * the picture is re-encoded (no EXIF/GPS) and ENCRYPTED by the app (AES-256-GCM with
--     SETTINGS_ENCRYPTION_KEY, bound to the booking and kind): the database never holds it readable;
--   * only that shop's members can read the row (and only the server can decrypt it);
--   * it is deleted automatically `document_retention_days` after the rental ends (default 30), and
--     at once when the booking is cancelled or expires (src/v2/rental-documents.js purge);
--   * members may delete it early and mark it checked; nobody can change a stored document.
--
--   offerings.required_documents                 which documents the service asks for
--   business_booking_settings.document_retention_days
--   booking_documents                            one row per document (a new upload of a kind replaces the old)
--   customer_submit_document(...)                the customer's upload, by their booking link (server only)
-- Safe to run again.

alter table public.offerings add column if not exists required_documents text[] not null default '{}';
alter table public.offerings drop constraint if exists offerings_required_documents_check;
alter table public.offerings add constraint offerings_required_documents_check
  check (required_documents <@ array['id_card', 'driving_license', 'passport']::text[]);

alter table public.business_booking_settings add column if not exists document_retention_days int not null default 30;
alter table public.business_booking_settings drop constraint if exists business_booking_settings_document_retention_check;
alter table public.business_booking_settings add constraint business_booking_settings_document_retention_check
  check (document_retention_days between 1 and 365);

create table if not exists public.booking_documents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  booking_id uuid not null,
  kind text not null check (kind in ('id_card', 'driving_license', 'passport')),
  sealed bytea not null check (octet_length(sealed) between 29 and 2097152), -- iv + tag + encrypted WebP
  consent_at timestamptz not null,
  delete_after timestamptz not null,
  reviewed_at timestamptz,
  reviewed_by uuid,
  created_at timestamptz not null default now(),
  unique (booking_id, kind),
  foreign key (booking_id, business_id) references public.bookings(id, business_id) on delete cascade
);
create index if not exists booking_documents_delete_after_idx on public.booking_documents(delete_after);

alter table public.booking_documents enable row level security;
drop policy if exists booking_documents_select on public.booking_documents;
create policy booking_documents_select on public.booking_documents for select to authenticated using (public.is_business_member(business_id));
drop policy if exists booking_documents_review on public.booking_documents;
create policy booking_documents_review on public.booking_documents for update to authenticated
  using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));
drop policy if exists booking_documents_delete on public.booking_documents;
create policy booking_documents_delete on public.booking_documents for delete to authenticated using (public.is_business_member(business_id));
revoke all on public.booking_documents from anon;
revoke all on public.booking_documents from authenticated;
grant select, delete on public.booking_documents to authenticated;
grant update (reviewed_at, reviewed_by) on public.booking_documents to authenticated;
grant all on public.booking_documents to service_role;

-- The customer's document, already re-encoded and encrypted by the server (p_sealed). The booking is
-- found by its link (token hash), must still be on, and its service must ask for that kind.
create or replace function public.customer_submit_document(p_business_id uuid, p_token_hash text, p_kind text, p_sealed bytea)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_days int;
  v_id uuid;
begin
  select * into v_booking from public.bookings
   where business_id = p_business_id and manage_token_hash = p_token_hash
   for update;
  if not found then
    raise exception using errcode = 'BK404', message = 'NOT_FOUND';
  end if;
  if v_booking.status not in ('held', 'pending', 'confirmed', 'checked_in') then
    raise exception using errcode = 'BK422', message = 'NOT_CHANGEABLE';
  end if;
  if not exists (select 1 from public.offerings o where o.id = v_booking.offering_id and p_kind = any(o.required_documents)) then
    raise exception using errcode = 'BK422', message = 'DOCUMENT_NOT_ASKED';
  end if;
  select coalesce((select document_retention_days from public.business_booking_settings where business_id = p_business_id), 30) into v_days;
  delete from public.booking_documents where booking_id = v_booking.id and kind = p_kind;
  insert into public.booking_documents (business_id, booking_id, kind, sealed, consent_at, delete_after)
  values (p_business_id, v_booking.id, p_kind, p_sealed, now(), v_booking.end_at + make_interval(days => v_days))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.customer_submit_document(uuid, text, text, bytea) from public, anon, authenticated;

-- Copy the documents a service asks for when a branch is added from another (add_branch copies
-- offerings column by column; the new column starts empty there, which only means "ask for nothing").
