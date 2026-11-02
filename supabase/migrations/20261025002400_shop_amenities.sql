-- The venue page (owner's reference designs: "Facilities", "About"): what the shop offers its
-- customers, from a fixed list with icons (src/v2/amenities.js), and a short "about the shop" text.
-- Both live on businesses, so the existing row level security applies: members read their shop,
-- only the owner changes it (src/v2/admin-catalog.js saveShop), the customer page reads them through
-- the server.

alter table public.businesses add column amenities text[] not null default '{}';
alter table public.businesses add constraint businesses_amenities_check check (
  cardinality(amenities) <= 16
  and amenities <@ array['parking','lights','indoor','aircon','shower','toilet','changing','locker',
                         'water','food','rental','ball','seats','wifi','cctv','first_aid']::text[]
);

alter table public.businesses add column about text check (about is null or length(about) <= 1000);
