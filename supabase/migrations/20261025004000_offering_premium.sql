-- "พรีเมียม ✨" on a service is the shop's own choice (design "Kiwmee ปรับหน้าตา"): before this the
-- booking page guessed it from the price (2,000 baht or more). A shop ticks it per service on its
-- catalogue page; nothing is premium until a shop says so. Offerings keep their existing RLS.
-- IMPORTANT: run on Kiwmee BEFORE deploying the code. Safe to run again.

alter table public.offerings add column if not exists premium boolean not null default false;
