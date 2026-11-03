-- The brand's logo on its membership card (docs/LOYALTY_DESIGN.md §3.1: "[โลโก้แบรนด์]"): on the member's
-- LINE page, in the shop's preview, and on the LINE cards (moved up a tier, points running out).
-- Uploaded like shop photos (Storage, re-encoded WebP) and saved here by the brand's owner only.
-- IMPORTANT: run on booking-v2 BEFORE deploying the code. Safe to run again.

alter table public.brands add column if not exists logo_url text;
alter table public.brands drop constraint if exists brands_logo_url_check;
alter table public.brands add constraint brands_logo_url_check check (
  logo_url is null or public.valid_catalog_media(jsonb_build_array(jsonb_build_object('url', logo_url, 'alt', '')))
);

create or replace function public.brand_set_logo(p_brand_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_brand_owner(p_brand_id) then
    raise exception 'only the brand owner sets the logo' using errcode = '42501';
  end if;
  update public.brands set logo_url = nullif(trim(p_url), ''), updated_at = now() where id = p_brand_id;
end;
$$;

revoke execute on function public.brand_set_logo(uuid, text) from public, anon;
grant execute on function public.brand_set_logo(uuid, text) to authenticated, service_role;
