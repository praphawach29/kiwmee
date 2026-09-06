-- ============================================================================
-- Salon Booking OS v1 — Pilot #1 Real Salon Seed Data Template
-- ============================================================================
-- Description: Real salon configuration seed for Pilot #1.
-- This template is separate from the starter kit demo SEED_DATA.sql.
-- Customize the services, staff, skills mapping, and working hours for your salon.
-- ============================================================================

BEGIN;

-- 1. Real Services Catalog
-- Duration is in minutes (service duration + buffer). Price in THB.
INSERT INTO services (name, description, duration_minutes, price, active) VALUES
('ตัดผมและจัดทรง (Haircut & Style)', 'บริการสระ ตัดแต่ง และเซ็ตทรงผมตามสไตล์ลูกค้า', 60, 600.00, true),
('สระไดร์พรีเมียม (Signature Wash & Blow)', 'สระผมด้วยแชมพูพรีเมียม นวดศีรษะผ่อนคลาย และไดร์จัดแต่งทรง', 45, 350.00, true),
('ทำสีผมแฟชั่น (Hair Color & Gloss)', 'บริการทำสีผม ทรีตเมนต์เคลือบเงา บำรุงสีผมให้ติดทน', 120, 2500.00, true),
('สปาทรีตเมนต์ฟื้นฟูผม (Deep Repair Hair Spa)', 'อบไอน้ำและทรีตเมนต์บำรุงผมเสียแห้งแตกปลายอย่างล้ำลึก', 90, 1500.00, true),
('ดีท็อกซ์หนังศีรษะ (Scalp Detox & Massage)', 'ทำความสะอาดคราบเคมีตกค้าง นวดกระตุ้นการไหลเวียนโลหิต', 60, 950.00, true)
ON CONFLICT DO NOTHING;

-- 2. Staff Profiles
INSERT INTO staff (name, phone, active) VALUES
('ช่างแอน (Senior Stylist)', '0811112222', true),
('ช่างมีน (Color Specialist)', '0822223333', true),
('ช่างกานต์ (Stylist & Scalp Specialist)', '0833334444', true)
ON CONFLICT DO NOTHING;

-- 3. Staff-Service Capabilities Mapping
-- ช่างแอน: ตัดผม, สระไดร์, สปาทรีตเมนต์, ดีท็อกซ์หนังศีรษะ
INSERT INTO staff_services (staff_id, service_id)
SELECT st.id, sv.id
FROM staff st
CROSS JOIN services sv
WHERE st.name = 'ช่างแอน (Senior Stylist)'
  AND sv.name IN (
    'ตัดผมและจัดทรง (Haircut & Style)',
    'สระไดร์พรีเมียม (Signature Wash & Blow)',
    'สปาทรีตเมนต์ฟื้นฟูผม (Deep Repair Hair Spa)',
    'ดีท็อกซ์หนังศีรษะ (Scalp Detox & Massage)'
  )
ON CONFLICT (staff_id, service_id) DO NOTHING;

-- ช่างมีน: ทำสีผม, สปาทรีตเมนต์, สระไดร์, ตัดผม
INSERT INTO staff_services (staff_id, service_id)
SELECT st.id, sv.id
FROM staff st
CROSS JOIN services sv
WHERE st.name = 'ช่างมีน (Color Specialist)'
  AND sv.name IN (
    'ทำสีผมแฟชั่น (Hair Color & Gloss)',
    'สปาทรีตเมนต์ฟื้นฟูผม (Deep Repair Hair Spa)',
    'สระไดร์พรีเมียม (Signature Wash & Blow)',
    'ตัดผมและจัดทรง (Haircut & Style)'
  )
ON CONFLICT (staff_id, service_id) DO NOTHING;

-- ช่างกานต์: ตัดผม, สระไดร์, ดีท็อกซ์หนังศีรษะ
INSERT INTO staff_services (staff_id, service_id)
SELECT st.id, sv.id
FROM staff st
CROSS JOIN services sv
WHERE st.name = 'ช่างกานต์ (Stylist & Scalp Specialist)'
  AND sv.name IN (
    'ตัดผมและจัดทรง (Haircut & Style)',
    'สระไดร์พรีเมียม (Signature Wash & Blow)',
    'ดีท็อกซ์หนังศีรษะ (Scalp Detox & Massage)'
  )
ON CONFLICT (staff_id, service_id) DO NOTHING;

-- 4. Initial Working Hours & Breaks (Pilot Week Sample Schedule)
-- Opening hours: 10:00 - 19:00 (Asia/Bangkok)
-- Lunch break: 12:30 - 13:30
-- Generates working slots for the next 14 days from current date
DO $$
DECLARE
  staff_rec RECORD;
  day_offset INT;
  target_date DATE;
  work_start TIMESTAMPTZ;
  work_end TIMESTAMPTZ;
  lunch_start TIMESTAMPTZ;
  lunch_end TIMESTAMPTZ;
BEGIN
  FOR staff_rec IN SELECT id, name FROM staff WHERE active = true LOOP
    FOR day_offset IN 0..14 LOOP
      target_date := (CURRENT_DATE + day_offset);
      
      -- กำหนดเวลาทำงาน 10:00 - 19:00 ในเขตเวลา Asia/Bangkok
      work_start := (target_date || ' 10:00:00+07')::TIMESTAMPTZ;
      work_end := (target_date || ' 19:00:00+07')::TIMESTAMPTZ;
      
      -- พักกลางวัน 12:30 - 13:30 (หรือสลับเวลาตามช่าง)
      IF staff_rec.name LIKE '%ช่างมีน%' THEN
        lunch_start := (target_date || ' 13:00:00+07')::TIMESTAMPTZ;
        lunch_end := (target_date || ' 14:00:00+07')::TIMESTAMPTZ;
      ELSE
        lunch_start := (target_date || ' 12:00:00+07')::TIMESTAMPTZ;
        lunch_end := (target_date || ' 13:00:00+07')::TIMESTAMPTZ;
      END IF;

      -- เพิ่มเวลาทำงาน (type = 'available')
      INSERT INTO availability (staff_id, start_at, end_at, type, note)
      VALUES (staff_rec.id, work_start, work_end, 'available', 'Regular working shift')
      ON CONFLICT DO NOTHING;

      -- เพิ่มช่วงพัก (type = 'blocked')
      INSERT INTO availability (staff_id, start_at, end_at, type, note)
      VALUES (staff_rec.id, lunch_start, lunch_end, 'blocked', 'Lunch break')
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
