# Flexible Booking — Design (v2)

สถานะ: **ร่างเพื่อรีวิว** · 25 ต.ค. 2569 · ยังไม่มีโค้ดตามเอกสารนี้

เป้าหมาย: ให้ร้านแต่ละร้านตั้งเองได้ว่าลูกค้าจองแบบไหน และย้ายไป Supabase เพื่อเปิดเป็น SaaS หลายร้าน
ตัวอย่างที่ต้องทำได้:

- ร้านเสริมสวย: เลือก **บริการ → ช่าง → วันเวลา** (แบบที่ repo ทำได้อยู่แล้ว)
- สปา: เลือก **วันที่ → เวลา → บริการที่ว่างวันนั้น**
- สนามกีฬา: เลือก **สนาม → วันที่ → เวลาเริ่ม + จำนวนชั่วโมง** คิดเงินรายชั่วโมง ราคาช่วงเย็นแพงกว่า
- คลาส/เวิร์กช็อป: รอบละหลายคน (ความจุ > 1)

---

## 1. ของเดิมที่ใช้ต่อ และข้อจำกัดที่ต้องแก้

ใช้ต่อ (แนวคิดและโค้ดส่วนใหญ่):

| ของเดิม | ไฟล์ | ใช้ต่อยังไง |
|---|---|---|
| กันจองชนที่ระดับฐานข้อมูล (exclusion constraint) | `database/schema.sql` `bookings_no_staff_overlap` | ย้ายไปไว้ที่ `booking_resources` (ข้อ 4.6) |
| คำนวณช่องว่าง: เวลาทำการ, วันหยุดร้าน, ตารางพนักงาน, วันลา, lead time, เหตุผลที่ไม่มีคิว | `src/availability-engine.js`, migration 008 | เปลี่ยนจาก "พนักงาน" เป็น "ทรัพยากร" ตรรกะเดิมเกือบทั้งหมดใช้ได้ |
| สร้าง/เลื่อน/ยกเลิกการจอง พร้อมประวัติสถานะ | `src/booking-service.js`, `booking_status_history` | ย้ายเข้า RPC ใน Postgres (ข้อ 6) |
| ชำระเงิน + ตรวจสลิป + state machine | `src/payment/*`, migration 007 | คงไว้ เพิ่ม `business_id` |
| LINE webhook, automation jobs, AI receptionist | `src/messaging/*`, `src/automation/*`, `src/ai/*` | คงไว้ เปลี่ยนให้เรียก API ใหม่ |

ข้อจำกัดที่เอกสารนี้แก้:

| # | ข้อจำกัด | ที่มา |
|---|---|---|
| L1 | ขั้นตอนจองตายตัว `service → staff → time → customer` | `src/ui/booking-flow.js` `STEPS` |
| L2 | ทุกการจองต้องมีพนักงาน สนาม/ห้อง/อุปกรณ์ไม่มีที่อยู่ | `bookings.staff_id not null` |
| L3 | 1 ช่วงเวลารับได้ 1 การจองเท่านั้น | exclusion constraint บน `staff_id` |
| L4 | ระยะเวลาและราคาผูกกับบริการตายตัว | `services.duration_minutes`, `services.price` |
| L5 | ร้านเดียว (`business_id text default 'default'`, ตารางหลักไม่มีคอลัมน์ร้าน) | schema + migration 008 |
| L6 | ต่อ Postgres ตรง + ระบบล็อกอินแอดมินของตัวเอง | `pg`, `src/security/*` |

---

## 2. แนวคิดหลัก 4 ข้อ

1. **ทรัพยากร (resource)** แทน "พนักงาน": สิ่งที่ถูกจองแล้วคนอื่นใช้ไม่ได้ในช่วงเวลานั้น
   มีชนิด `staff | court | room | equipment` และ **ความจุ** (สนาม = 1, คลาสโยคะ = 12)
2. **บริการ (offering)** บอกว่าต้องใช้ทรัพยากรอะไร ใช้นานเท่าไหร่ (ตายตัวหรือให้ลูกค้าเลือก) และคิดราคาแบบไหน
3. **ขั้นตอนจอง (flow)** ร้านตั้งเองได้ เป็นลำดับของขั้น เช่น `["resource","date","time","customer"]`
4. **คิวว่างแบบ "ขั้นถัดไปเหลืออะไร"**: เครื่องคำนวณรับ *สิ่งที่ลูกค้าเลือกไปแล้ว (ลำดับไหนก็ได้)*
   แล้วตอบตัวเลือกของขั้นที่ถาม เช่น "เลือกสนาม A แล้ว → วันไหนในสัปดาห์นี้ยังว่าง"
   ทุก flow ใช้เครื่องคำนวณตัวเดียวกัน ไม่ต้องเขียนตรรกะต่อ flow

---

## 3. Supabase: โครงสร้างและความปลอดภัย

| ส่วน | ใช้อะไร |
|---|---|
| ข้อมูล | Postgres ของ Supabase · migration ทุกไฟล์อยู่ใน `supabase/migrations/` (ห้ามแก้ DB มือโดยไม่มี migration) |
| แอดมินร้าน | Supabase Auth (อีเมล/รหัสผ่าน หรือ LINE Login ภายหลัง) + ตาราง `business_members` |
| ลูกค้าจองผ่านเว็บ | ไม่ต้องล็อกอิน เรียก RPC ที่เปิดให้ `anon` เฉพาะที่จำเป็น (อ่านตัวเลือก, สร้างการจองแบบ hold) |
| ลูกค้าจองผ่าน LIFF | ส่ง LINE ID token มา ตรวจฝั่งเซิร์ฟเวอร์ (Next.js API route) แล้วผูก `customers.line_user_id` |
| งานเบื้องหลัง (เตือนนัด, หมดเวลา hold, no-show) | pg_cron → API route หรือ Edge Function ด้วย service role |

### กติกาความปลอดภัย (บทเรียนจาก DealMee / CheckMee)

- **ทุกตารางมี `business_id uuid not null references businesses(id)`** และเปิด RLS ทุกตาราง
  นโยบายมาตรฐาน: สมาชิกร้านอ่าน/เขียนได้เฉพาะแถวที่ `business_id` อยู่ในร้านของตัวเอง
  (`business_id in (select business_id from business_members where user_id = auth.uid())`)
- `anon` **อ่านตารางตรงไม่ได้เลย** ข้อมูลที่หน้าจองต้องใช้ ส่งผ่าน RPC `security definer` ที่คืนเฉพาะคอลัมน์ที่จำเป็น
  (ชื่อบริการ ราคา ช่องว่าง) ไม่มีข้อมูลลูกค้าคนอื่น
- ฟังก์ชันที่ใช้ภายในเท่านั้น: `revoke execute … from public, anon, authenticated` **ระบุชื่อ role ครบ**
  (Supabase grant ให้ anon/authenticated ตรง ๆ การ revoke จาก public อย่างเดียวไม่พอ)
  และ `grant execute … to service_role` ในไฟล์ migration เสมอ
- ตารางใหม่ที่ Edge Function ต้องอ่าน: `grant … to service_role` ในไฟล์ migration
- มีชุดทดสอบ RLS (ร้าน A ห้ามเห็นข้อมูลร้าน B) ก่อนเปิดให้ร้านที่สองใช้

---

## 4. โครงสร้างข้อมูล

> SQL ด้านล่างเป็นร่างเพื่อสื่อแนวคิด จะเขียนจริงตอนทำ migration

### 4.1 ร้านและสมาชิก

```sql
create table businesses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,            -- ใช้ใน URL หน้าจอง: /b/<slug>
  name text not null,
  timezone text not null default 'Asia/Bangkok',
  created_at timestamptz not null default now()
);

create table business_members (
  business_id uuid references businesses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','staff')),
  primary key (business_id, user_id)
);
```

### 4.2 ทรัพยากร

```sql
create table resources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  kind text not null check (kind in ('staff','court','room','equipment')),
  name text not null,                    -- "ช่างแนน", "สนาม 2 (หญ้าเทียม)"
  capacity int not null default 1 check (capacity >= 1),
  member_user_id uuid,                   -- ถ้าเป็นพนักงานที่ล็อกอินได้
  sort_order int not null default 0,
  active boolean not null default true
);
```

ตารางเวลาเปลี่ยนชื่อจากของเดิม เปลี่ยนแค่ `staff_id` → `resource_id`:
`resource_schedules` (จาก `staff_schedules`), `resource_time_off` (จาก `staff_time_off`)
ส่วน `business_hours`, `business_closures`, `business_booking_settings` คงไว้ เปลี่ยน `business_id` เป็น uuid

### 4.3 บริการ

```sql
create table offerings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  category text,                          -- ใช้จัดกลุ่ม และผูก flow ต่อหมวดได้
  name text not null,
  description text,
  duration_mode text not null default 'fixed' check (duration_mode in ('fixed','customer_choice')),
  duration_minutes int,                   -- fixed
  min_minutes int, max_minutes int, step_minutes int,   -- customer_choice เช่น 60..180 ทีละ 60
  buffer_after_minutes int not null default 0,          -- เวลาเก็บของ/ทำความสะอาดหลังจบ
  max_party_size int not null default 1,  -- คลาสที่จองทีละหลายคน
  active boolean not null default true,
  check (duration_mode = 'customer_choice' or duration_minutes > 0),
  check (duration_mode = 'fixed' or (min_minutes > 0 and max_minutes >= min_minutes and step_minutes > 0))
);

-- บริการนี้ต้องใช้ทรัพยากรอะไร (หนึ่งบริการต้องใช้ได้หลายอย่าง เช่น ช่าง 1 + ห้อง 1)
create table offering_requirements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  offering_id uuid not null references offerings(id) on delete cascade,
  kind text not null,                     -- ต้องการทรัพยากรชนิดไหน
  customer_picks boolean not null default false,  -- ให้ลูกค้าเลือกเอง หรือระบบเลือกตัวที่ว่างให้
  units_per_booking text not null default 'one' check (units_per_booking in ('one','party_size'))
);

-- ทรัพยากรตัวไหนทำบริการนี้ได้ (แทน staff_services)
create table offering_resources (
  offering_id uuid references offerings(id) on delete cascade,
  resource_id uuid references resources(id) on delete cascade,
  business_id uuid not null references businesses(id),
  primary key (offering_id, resource_id)
);
```

### 4.4 ราคา

```sql
create table price_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  offering_id uuid not null references offerings(id) on delete cascade,
  unit text not null check (unit in ('per_booking','per_hour','per_person')),
  amount numeric(12,2) not null check (amount >= 0),
  days_of_week int[],                     -- null = ทุกวัน
  start_time time, end_time time,         -- null = ทั้งวัน
  priority int not null default 0         -- กฎเจาะจงกว่าชนะ
);
```

คิดราคาในโค้ด (ฟังก์ชันเดียว ทดสอบง่าย) แล้ว**บันทึกราคาสุดท้ายลงการจอง** (`bookings.price_snapshot jsonb`)
ร้านแก้ราคาภายหลัง การจองเก่าไม่เปลี่ยน
ตัวอย่างสนาม: 300 บาท/ชม. ทุกวัน 08:00–17:00, 450 บาท/ชม. 17:00–23:00 → จอง 16:00–18:00 = 300 + 450 = 750

### 4.5 ขั้นตอนจอง

```sql
create table booking_flows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  category text,                           -- null = ค่าเริ่มต้นของร้าน
  steps text[] not null,                   -- ดูกติกาข้อ 5
  options jsonb not null default '{}',     -- เช่น {"date_range_days": 14, "show_any_staff": true}
  unique (business_id, category)
);
```

### 4.6 การจอง และการกันชน

```sql
create table bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  customer_id uuid not null references customers(id),
  offering_id uuid not null references offerings(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  party_size int not null default 1,
  status text not null check (status in
    ('held','pending','confirmed','checked_in','completed','cancelled','no_show','expired')),
  hold_expires_at timestamptz,            -- ใช้กับ status = held (ระหว่างรอชำระเงิน)
  price_snapshot jsonb not null,
  source text not null default 'web' check (source in ('web','liff','line_chat','admin')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

-- ทรัพยากรที่การจองนี้ถือไว้ (ช่าง + ห้อง, หรือสนาม, หรือที่นั่งในคลาส)
create table booking_resources (
  booking_id uuid references bookings(id) on delete cascade,
  resource_id uuid references resources(id),
  business_id uuid not null references businesses(id),
  units int not null default 1,
  exclusive boolean not null,              -- คัดลอกจาก resources.capacity = 1 ตอนสร้าง
  active boolean not null default true,    -- false เมื่อยกเลิก/หมดอายุ
  range tstzrange not null,                -- รวม buffer_after แล้ว
  primary key (booking_id, resource_id)
);

-- ทรัพยากรความจุ 1: ฐานข้อมูลกันชนเอง แบบเดียวกับ bookings_no_staff_overlap เดิม
alter table booking_resources add constraint no_overlap_exclusive
  exclude using gist (resource_id with =, range with &&) where (exclusive and active);
```

- **ความจุ 1** (ช่าง, สนาม): exclusion constraint กันชน ถึงสองคนกดพร้อมกันก็จองซ้ำไม่ได้
- **ความจุ > 1** (คลาส): constraint ทำไม่ได้ ใช้ RPC `create_booking` ล็อกทรัพยากรด้วย
  `pg_advisory_xact_lock(hashtext(resource_id::text))` แล้วรวม `units` ในช่วงเวลาที่ทับกัน ต้องไม่เกิน `capacity`
- **hold ระหว่างรอชำระเงิน**: `status = 'held'` + `hold_expires_at` (เช่น 10 นาที) แถวใน `booking_resources` เป็น active จึงกันคิวไว้ได้
  ก่อนสร้างการจองใหม่ RPC ปลด hold ที่หมดอายุของทรัพยากรนั้นก่อน (constraint ใช้ `now()` ไม่ได้) และ cron เก็บกวาดทุก 5 นาที

---

## 5. ขั้นตอนจองที่ร้านตั้งเองได้

ขั้นที่มีให้เลือก:

| ขั้น | ลูกค้าเลือกอะไร | หมายเหตุ |
|---|---|---|
| `offering` | บริการ | |
| `resource` | ทรัพยากรที่ `customer_picks = true` เช่น ช่าง สนาม | มีตัวเลือก "ใครก็ได้" ถ้าร้านเปิด `show_any_staff` |
| `date` | วันที่ | แสดงปฏิทิน มีจุดบอกวันที่ยังว่าง |
| `time` | เวลาเริ่ม | |
| `duration` | ระยะเวลา | เฉพาะบริการ `customer_choice` · รวมกับขั้น time ได้ |
| `party` | จำนวนคน | เฉพาะบริการ `max_party_size > 1` |
| `customer` | ชื่อ เบอร์ (LIFF เติมให้) | ต้องอยู่หลังขั้นที่เลือกเวลาเสมอ |
| `payment` | มัดจำ/ชำระ | ถ้าบริการต้องชำระก่อน |

กติกาตรวจตอนร้านบันทึก flow (ป้องกันร้านตั้ง flow ที่จองไม่สำเร็จ):

1. ต้องมี `date` และ `time` และ `time` อยู่หลัง `date`
2. ต้องมี `offering` หรือร้านมีบริการเดียวในหมวดนั้น (ระบบเลือกให้)
3. `customer` อยู่หลังทุกขั้นที่กำหนดเวลา · `payment` อยู่ท้ายสุด
4. ขั้นที่ไม่เกี่ยวกับบริการที่เลือก (เช่น `duration` กับบริการ fixed) ระบบข้ามให้เอง

### ตัวอย่างการตั้งค่า 3 ร้าน

```jsonc
// ร้านเสริมสวย (แบบที่ repo ทำอยู่)
{ "steps": ["offering", "resource", "date", "time", "customer"],
  "options": { "show_any_staff": true, "date_range_days": 30 } }

// สปา: เลือกวันก่อน เห็นเฉพาะบริการที่ยังมีคิววันนั้น
{ "steps": ["date", "time", "offering", "customer", "payment"],
  "options": { "date_range_days": 14 } }

// สนามกีฬา: เลือกสนามก่อน ดูว่าวันไหนว่าง แล้วเลือกเวลา + จำนวนชั่วโมง
// offering "เช่าสนามฟุตบอล 7 คน": duration_mode customer_choice 60..180 ทีละ 60
// requirement: kind court, customer_picks true
{ "steps": ["resource", "date", "time", "duration", "customer", "payment"],
  "options": { "date_range_days": 7 } }
```

---

## 6. เครื่องคำนวณคิวว่าง: "ขั้นถัดไปเหลืออะไร"

### API เดียวสำหรับทุก flow

```http
POST /api/b/{slug}/options
{
  "ask": "date",                        // offering | resource | date | time | duration
  "selected": {                         // อะไรที่เลือกแล้วก็ได้ ลำดับไหนก็ได้
    "resourceId": "…สนาม 2…",
    "offeringId": null, "date": null, "time": null, "durationMinutes": null, "partySize": 1
  }
}
→
{
  "options": [
    { "value": "2026-10-26", "available": true },
    { "value": "2026-10-27", "available": false, "reason": "FULLY_BOOKED" },
    { "value": "2026-10-28", "available": false, "reason": "BUSINESS_CLOSED" }
  ]
}
```

`reason` ใช้รหัสชุดเดิมของ repo (`ZERO_AVAILABILITY_REASONS`) หน้าจอจะได้บอกลูกค้าว่าทำไมไม่ว่าง

### วิธีคิด

1. **ขอบเขต**: วันจาก `selected.date` หรือ วันนี้ … +`date_range_days` (ไม่เกิน `max_advance_booking_days`)
   บริการจาก `selected.offeringId` หรือทุกบริการที่ใช้ได้ ทรัพยากรจาก `selected.resourceId` หรือทุกตัวที่ทำบริการนั้นได้
2. **หาช่องว่างของทรัพยากร** (ตรรกะเดิมใน `availability-engine.js`):
   เวลาทำการร้าน ∩ ตารางทรัพยากร − วันหยุด − วันลา − การจองที่ active (สำหรับความจุ > 1: ลบเฉพาะช่วงที่เต็ม)
3. **สร้างตัวเลือกที่เป็นไปได้** (บริการ, ทรัพยากรทุกชิ้นที่ต้องใช้, เวลาเริ่ม, ระยะเวลา) ทีละ `slot_interval_minutes`
   ใช้ได้เมื่อทรัพยากร**ทุกชิ้น**ที่บริการต้องใช้ว่างพร้อมกันตลอดช่วง รวม buffer
4. **ยุบเหลือเฉพาะมิติที่ถาม** เช่น ถาม `date` ตอบแค่ว่าวันไหนมีตัวเลือกอย่างน้อย 1 ตัว
   (หยุดคำนวณวันนั้นทันทีที่เจอตัวแรก ปฏิทิน 14 วันจึงไม่ช้า)

ทุก flow ใช้ฟังก์ชันนี้ตัวเดียว ต่างกันแค่ `ask` กับ `selected` · ฟังก์ชันเป็นตรรกะล้วน (รับข้อมูล คืนตัวเลือก)
ทดสอบด้วย unit test ได้โดยไม่ต้องมีฐานข้อมูล

### ตอนกดยืนยัน

`create_booking` (RPC `security definer`) **คำนวณซ้ำฝั่งฐานข้อมูล** ไม่เชื่อค่าจากหน้าเว็บ:
ตรวจขั้นที่ flow บังคับครบ → เลือกทรัพยากรที่ว่าง (กรณี "ใครก็ได้") → คิดราคา → insert `bookings` + `booking_resources`
ถ้า constraint หรือการตรวจความจุไม่ผ่าน ตอบ `CONFLICT` (หน้าจอแสดง "ช่วงเวลานี้เพิ่งถูกจอง" แบบที่ repo มีอยู่แล้ว)

---

## 7. LINE

- **LIFF**: หน้าจองตัวเดียวกับเว็บ อ่าน flow เดียวกัน เติมชื่อ/LINE ID ให้อัตโนมัติ
- **การ์ดยืนยัน/เตือนนัด**: ใช้ `line-flex-builder.js` เดิม มีปุ่ม "เลื่อนนัด" / "ยกเลิก" เปิด LIFF ที่ขั้นที่ถูกต้อง
- **ลูกค้าพิมพ์เอง** ("พรุ่งนี้บ่ายสองว่างไหม นวดไทย"): ระยะหลัง
  ใช้ TypeSafe (Jev) เลือก**จากรายการจริง**ว่าลูกค้าหมายถึงบริการไหน และ "พรุ่งนี้บ่ายสอง" ตรงกับตัวเลือกวันเวลาไหน
  เติมลงใน `selected` แล้วส่งลิงก์ LIFF ที่เลือกให้ครึ่งทาง **ไม่จองแทนลูกค้าจากแชทโดยไม่กดยืนยัน**

---

## 8. ย้ายจากของเดิม

| ของเดิม | ของใหม่ |
|---|---|
| `staff` | `resources (kind = 'staff')` |
| `staff_services` | `offering_resources` + `offering_requirements (kind staff, customer_picks true)` |
| `staff_schedules`, `staff_time_off` | `resource_schedules`, `resource_time_off` |
| `services.duration_minutes`, `services.price` | `offerings (duration_mode fixed)` + `price_rules (per_booking)` |
| `bookings.staff_id`, `bookings_no_staff_overlap` | `booking_resources` + `no_overlap_exclusive` |
| `business_id text 'default'` | `businesses` 1 แถว แล้วทุกตารางอ้าง uuid |
| `STEPS` ตายตัว | `booking_flows` ค่าเริ่มต้น `["offering","resource","date","time","customer"]` |
| login แอดมินของตัวเอง (`src/security/*`) | Supabase Auth + `business_members` |

ข้อมูลทดสอบใน `SEED_DATA.sql` ย้ายเป็น seed ของร้านตัวอย่าง 3 ร้าน (เสริมสวย, สปา, สนาม) ใช้ทั้งทดสอบและเดโม

---

## 9. ลำดับการทำ

| ขั้น | งาน | เสร็จเมื่อ |
|---|---|---|
| 1 | สร้างโปรเจกต์ Supabase · migration: businesses, members, resources, offerings, requirements, price_rules, flows, bookings, booking_resources + RLS ทุกตาราง | `supabase db reset` ผ่าน · ทดสอบ RLS: ร้าน A อ่าน/เขียนข้อมูลร้าน B ไม่ได้ |
| 2 | เครื่องคำนวณ `getOptions` (ตรรกะล้วน) ย้ายมาจาก `availability-engine.js` | unit test ครบ 3 ร้านตัวอย่าง: ทุก `ask` ทุกลำดับ, ความจุ > 1, buffer, ระยะเวลาให้ลูกค้าเลือก |
| 3 | RPC `create_booking` / `reschedule_booking` / `cancel_booking` + hold หมดอายุ | ทดสอบจองพร้อมกัน 2 คนช่องเดียว → สำเร็จ 1 อีกคนได้ `CONFLICT` · คลาสความจุ 12 รับคนที่ 13 ไม่ได้ |
| 4 | หน้าจองอ่าน flow (เว็บ + LIFF) | จองได้ครบทั้ง 3 flow ตัวอย่าง (Playwright) |
| 5 | หน้าแอดมิน: ทรัพยากร, บริการ, ราคา, ขั้นตอนจอง (มีตัวอย่างพรีวิว) | ร้านตั้ง flow สนามเองได้โดยไม่ต้องแก้โค้ด |
| 6 | ย้ายชำระเงิน, LINE, automation มาใช้ business_id + API ใหม่ | การ์ด LINE ยืนยัน/เตือนนัดใช้ได้กับทั้ง 3 ร้าน |
| 7 | (ภายหลัง) Jev สำหรับแชท · ราคา peak ซับซ้อน · จองซ้ำทุกสัปดาห์ · waitlist | — |

---

## 10. คำถามที่ต้องตอบก่อน/ระหว่างทำ

1. **กลุ่มลูกค้าแรก** (เสริมสวย/สปา หรือ สนามกีฬา) → กำหนดว่าร้านตัวอย่างไหนต้องสมบูรณ์ก่อน
2. **หลายสาขา**: นับเป็นหลายร้าน (`businesses`) ใต้บัญชีเดียว หรือเพิ่ม `branches` ในร้าน
3. **มัดจำ**: ตั้งต่อบริการ หรือต่อร้าน · ถ้าไม่จ่ายใน hold time ปล่อยคิวอัตโนมัติไหม
4. **นโยบายยกเลิก/เลื่อน**: ล่วงหน้ากี่ชั่วโมง ตั้งต่อบริการไหม
5. **ลูกค้าต้องมีบัญชีไหม**: เว็บใช้แค่ชื่อ+เบอร์ (OTP ภายหลัง) · LIFF ใช้ LINE
6. **repo**: ทำต่อใน repo นี้ (เปลี่ยนชื่อภายหลัง) หรือแยก repo ใหม่ ตอนย้ายไป Supabase
