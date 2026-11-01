-- booking-v2 ONLY (ezubgqeqdipwfnmorqkj). Run in its SQL Editor before deploying uploads.
-- Supabase manages storage.buckets/storage.objects; plain Postgres tests need the storage shim.
-- Images are deliberately public marketing assets. Do not upload private/customer documents.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-media', 'shop-media', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Exact business UUID / random-object UUID layout, with no casts on untrusted object names.
-- business_members is already RLS protected; this caller can only see their own memberships.
drop policy if exists shop_media_public_read on storage.objects;
create policy shop_media_public_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'shop-media');

drop policy if exists shop_media_owner_insert on storage.objects;
create policy shop_media_owner_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'shop-media'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
    and exists (
      select 1 from public.business_members m
      where m.business_id::text = split_part(name, '/', 1)
        and m.user_id = auth.uid() and m.role = 'owner'
    )
  );

-- Defense against an existing broad permissive Storage policy on this project.
-- These guards do not change any other bucket's access rules.
drop policy if exists shop_media_insert_guard on storage.objects;
create policy shop_media_insert_guard on storage.objects as restrictive
  for insert to anon, authenticated with check (
    bucket_id <> 'shop-media' or (
      name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
      and exists (
        select 1 from public.business_members m
        where m.business_id::text = split_part(name, '/', 1)
          and m.user_id = auth.uid() and m.role = 'owner'
      )
    )
  );

drop policy if exists shop_media_no_update on storage.objects;
create policy shop_media_no_update on storage.objects as restrictive
  for update to anon, authenticated
  using (bucket_id <> 'shop-media') with check (bucket_id <> 'shop-media');
drop policy if exists shop_media_no_delete on storage.objects;
create policy shop_media_no_delete on storage.objects as restrictive
  for delete to anon, authenticated using (bucket_id <> 'shop-media');

commit;
