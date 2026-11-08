-- The customer's note to the shop ("ฝากถึงร้าน", design "Kiwmee ปรับหน้าตา" · Confirm): asked on the
-- booking page, kept with the booking, shown to the shop on its bookings page. Up to 300 characters.
-- Written only by the server (the booking page's request); members read it like the rest of the
-- booking (existing RLS: their own shop only), anon nothing.
-- IMPORTANT: run on Kiwmee BEFORE deploying the code. Safe to run again.

alter table public.bookings add column if not exists customer_note text;
alter table public.bookings drop constraint if exists bookings_customer_note_check;
alter table public.bookings add constraint bookings_customer_note_check check (customer_note is null or char_length(customer_note) <= 300);
