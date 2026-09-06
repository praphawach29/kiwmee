insert into services (name, description, duration_minutes, price) values
('ตัดผม', 'ตัดและจัดทรง', 60, 500),
('ทำสีผม', 'บริการทำสีพื้นฐาน', 120, 1500),
('สระไดร์', 'สระและไดร์', 45, 350);

insert into staff (name, phone) values
('ช่างแอน', '0800000001'),
('ช่างมีน', '0800000002');

insert into staff_services (staff_id, service_id)
select staff.id, services.id
from staff
cross join services
where staff.name in ('ช่างแอน', 'ช่างมีน')
  and services.name in ('ตัดผม', 'ทำสีผม', 'สระไดร์')
on conflict do nothing;

insert into availability (staff_id, start_at, end_at, type, note)
select id, '2026-09-10T10:00:00+07:00'::timestamptz, '2026-09-10T18:00:00+07:00'::timestamptz, 'available', 'working hours'
from staff
where name in ('ช่างแอน', 'ช่างมีน');

insert into availability (staff_id, start_at, end_at, type, note)
select id, '2026-09-10T12:00:00+07:00'::timestamptz, '2026-09-10T13:00:00+07:00'::timestamptz, 'blocked', 'lunch break'
from staff
where name in ('ช่างแอน', 'ช่างมีน');
