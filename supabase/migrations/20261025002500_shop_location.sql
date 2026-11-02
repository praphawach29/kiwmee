-- "นำทาง" to the shop: its address, shown on the booking page, and an optional map link the owner
-- pastes from Google Maps / Apple Maps (src/v2/directions.js; without one the button searches the
-- address). Both live on businesses, so the existing row level security applies: members read their
-- shop, only the owner changes it, the customer pages read them through the server.

alter table public.businesses add column address text check (address is null or length(address) <= 300);
alter table public.businesses add column map_url text check (map_url is null or (length(map_url) <= 500 and map_url ~ '^https://'));
