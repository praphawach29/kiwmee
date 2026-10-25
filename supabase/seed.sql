-- Demo shops for local development and tests (supabase db reset runs this after migrations).
-- Two shops so tenant isolation is always exercised. Fixed ids so tests can refer to them.
--   Bloom Hair & Beauty: salon, customer starts from a date or a service, picks a stylist
--   Gentleman Barber:     barber, starts from a service, any barber is fine
-- No members: owners sign up and are linked by create_business(), or in tests.

insert into public.businesses (id, slug, name, kind) values
  ('b1000000-0000-4000-8000-000000000001', 'bloom-hair', 'Bloom Hair & Beauty', 'salon'),
  ('b2000000-0000-4000-8000-000000000002', 'gentleman-barber', 'Gentleman Barber', 'barber');

insert into public.business_booking_settings (business_id, min_lead_minutes, slot_interval_minutes, max_advance_days) values
  ('b1000000-0000-4000-8000-000000000001', 30, 15, 30),
  ('b2000000-0000-4000-8000-000000000002', 15, 15, 14);

-- Salon open 10–20 every day; barber closed Monday (1), 09–19 otherwise
insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
select 'b1000000-0000-4000-8000-000000000001', d, true, '10:00', '20:00' from generate_series(0, 6) d;
insert into public.business_hours (business_id, day_of_week, is_open, open_time, close_time)
select 'b2000000-0000-4000-8000-000000000002', d, d <> 1, '09:00', '19:00' from generate_series(0, 6) d;

insert into public.resources (id, business_id, kind, name, sort_order) values
  ('a1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'staff', 'ช่างแนน', 1),
  ('a1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'staff', 'ช่างบี', 2),
  ('a1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'staff', 'ช่างพลอย (ทำสีเท่านั้น)', 3),
  ('a2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', 'staff', 'ช่างโต้ง', 1),
  ('a2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'staff', 'ช่างเอก', 2);

-- Everyone works the shop's open days; ช่างบี is off on Wednesdays
insert into public.resource_schedules (business_id, resource_id, day_of_week, is_working, start_time, end_time)
select r.business_id, r.id, h.day_of_week,
       h.is_open and not (r.id = 'a1000000-0000-4000-8000-000000000002' and h.day_of_week = 3),
       h.open_time, h.close_time
from public.resources r join public.business_hours h on h.business_id = r.business_id;

insert into public.offerings (id, business_id, category, name, duration_mode, duration_minutes, buffer_after_minutes, sort_order) values
  ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'ตัด', 'ตัดผมหญิง + สระไดร์', 'fixed', 60, 10, 1),
  ('c1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'สี', 'ทำสีผม', 'fixed', 120, 15, 2),
  ('c1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'ทรีตเมนต์', 'ทรีตเมนต์บำรุงผม', 'fixed', 45, 0, 3),
  ('c2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', null, 'ตัดผมชาย', 'fixed', 30, 5, 1),
  ('c2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', null, 'ตัด + โกนหนวด', 'fixed', 45, 5, 2);

insert into public.offering_requirements (business_id, offering_id, kind, customer_picks)
select business_id, id, 'staff', business_id = 'b1000000-0000-4000-8000-000000000001' from public.offerings;

-- Salon: ช่างพลอย does colour only; the others do everything. Barber: both do everything.
insert into public.offering_resources (business_id, offering_id, resource_id)
select o.business_id, o.id, r.id
from public.offerings o join public.resources r on r.business_id = o.business_id
where not (r.id = 'a1000000-0000-4000-8000-000000000003' and o.id <> 'c1000000-0000-4000-8000-000000000002');

insert into public.price_rules (business_id, offering_id, unit, amount) values
  ('b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'per_booking', 450),
  ('b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'per_booking', 1500),
  ('b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'per_booking', 600),
  ('b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'per_booking', 200),
  ('b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'per_booking', 300);
-- Barber: evenings after 17:00 cost more
insert into public.price_rules (business_id, offering_id, unit, amount, start_time, end_time, priority) values
  ('b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'per_booking', 250, '17:00', '19:00', 1);

insert into public.booking_flows (business_id, entry, require, optional, "then", options) values
  ('b1000000-0000-4000-8000-000000000001', array['date','offering'], array['offering','date','time'], array['resource'], array['customer'],
   '{"show_any_staff": true, "date_range_days": 30}'),
  ('b2000000-0000-4000-8000-000000000002', array['offering'], array['offering','date','time'], array[]::text[], array['customer'],
   '{"date_range_days": 14}');
