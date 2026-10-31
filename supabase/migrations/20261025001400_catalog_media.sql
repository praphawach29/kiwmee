-- Media references only (no uploads, fetching, storage buckets, grants or RLS changes).
-- IMPORTANT: run this complete migration on booking-v2 BEFORE merging code that reads media.
-- businesses/offerings keep their existing owner-write/member-read RLS and anon denial.
begin;

create or replace function public.valid_catalog_media(p_media jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  item jsonb;
  media_url text;
  media_alt text;
begin
  if p_media is null or jsonb_typeof(p_media) <> 'array' then return false; end if;
  if jsonb_array_length(p_media) > 8 then return false; end if;
  for item in select value from jsonb_array_elements(p_media) loop
    if jsonb_typeof(item) <> 'object' then return false; end if;
    if not (item ? 'url' and item ? 'alt') or (item - 'url' - 'alt') <> '{}'::jsonb then return false; end if;
    if jsonb_typeof(item->'url') <> 'string' or jsonb_typeof(item->'alt') <> 'string' then return false; end if;
    media_url := item->>'url';
    media_alt := item->>'alt';
    if length(media_url) not between 1 and 2048 or length(media_alt) > 200 then return false; end if;
    if media_url ~ '[[:space:][:cntrl:]]' or strpos(media_url, chr(92)) > 0 or media_alt ~ '[[:cntrl:]]' then return false; end if;
    if left(media_url, 12) = '/demo-media/' then
      if media_url !~ '^/demo-media/([A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$' then return false; end if;
    elsif media_url !~ '^https://([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]]*)?$' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
-- Pure, invoker validation helper; never exposes data or adds an authorization path.
revoke all on function public.valid_catalog_media(jsonb) from public, anon;
grant execute on function public.valid_catalog_media(jsonb) to authenticated, service_role;

alter table public.businesses add column if not exists media jsonb not null default '[]'::jsonb;
alter table public.offerings add column if not exists media jsonb not null default '[]'::jsonb;
alter table public.businesses drop constraint if exists businesses_media_check;
alter table public.businesses add constraint businesses_media_check check (public.valid_catalog_media(media));
alter table public.offerings drop constraint if exists offerings_media_check;
alter table public.offerings add constraint offerings_media_check check (public.valid_catalog_media(media));

comment on column public.businesses.media is 'Ordered gallery: up to 8 {url,alt} references; HTTPS or /demo-media/ paths only. URL <=2048, alt <=200. No backend fetch.';
comment on column public.offerings.media is 'Ordered gallery: up to 8 {url,alt} references; HTTPS or /demo-media/ paths only. URL <=2048, alt <=200. No backend fetch.';
commit;
