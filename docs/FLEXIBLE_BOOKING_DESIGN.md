# Flexible Booking — Design (v2)

สถานะ: **ขั้นที่ 1–5 เสร็จ** (ฐานข้อมูล + RLS ใน `supabase/` · เครื่องคำนวณคิวว่าง `src/v2/options-engine.js` · RPC จอง/เลื่อน/ยกเลิก · หน้าจอง `/b/<slug>` · หน้าแอดมิน `/dashboard`)
\+ ร้านบันทึกการจองย้อนหลัง + ลูกค้ายกเลิก/เลื่อนนัดเองจากลิงก์ · ปรับล่าสุด 2 พ.ย. 2569 (เพิ่มข้อ 11: แบบระบบตัวเลือกเสริมและการจองหลายวัน)

**ตัดสินใจแล้ว** (25 ต.ค. 2569): ใช้ Supabase โปรเจกต์ `booking-v2` (`ezubgqeqdipwfnmorqkj`) ลง migration ขั้นที่ 1 แล้วผ่าน SQL Editor (ขั้นที่ 3–4 = ไฟล์ `…000300`, `…000400` รันเพิ่มแล้ว/ต้องรันเพิ่ม) ·
**ห้ามแตะ `rdbzdshvlfxenpsiyjzl`** — เป็นฐานข้อมูลของ v1 ที่บอท LINE ยังใช้งานอยู่ (ชื่อตารางชนกับ v2) · ทำต่อใน repo นี้ ·
กลุ่มลูกค้าแรก **ร้านเสริมสวย และร้านตัดผมชาย** · หน้าแรกให้ลูกค้าเลือกเองว่าจะเริ่มจากวันที่หรือจากบริการ (ข้อ 5)

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
| ลูกค้าจองผ่านเว็บ | ไม่ต้องล็อกอิน หน้าเว็บเรียก API route ของเรา (มี rate limit) ซึ่งเรียก RPC ด้วย service role · **`anon` เรียก RPC จองตรงไม่ได้** (เปลี่ยนจากร่างแรก: กันคนยิง hold เต็มปฏิทิน) |
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
  category text,                               -- null = ค่าเริ่มต้นของร้าน
  entry text[] default '{date,offering}',     -- ทางเริ่มที่ลูกค้าเลือกได้ (ตัวเดียว = บังคับ)
  require text[] default '{offering,date,time}', -- ต้องเลือกครบก่อน "then"
  optional text[] default '{resource}',        -- เลือกหรือไม่ก็ได้ (เช่น ช่าง: "ใครก็ได้")
  "then" text[] default '{customer}',          -- หลังเลือกครบ: customer, payment
  options jsonb not null default '{}',         -- เช่น {"date_range_days": 14, "show_any_staff": true}
  unique nulls not distinct (business_id, category)
);
```
ตัวจริงพร้อม check constraint อยู่ที่ `supabase/migrations/20261025000100_catalog.sql`

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

### หน้าแรก: ลูกค้าเลือกว่าจะเริ่มจากไหน

```
                 ┌──────────── หน้าแรกของร้าน ────────────┐
                 │                                        │
        [1] เลือกวันที่ก่อน                   [2] เลือกบริการก่อน
                 │                                        │
   ปฏิทิน: วันไหนยังมีคิว               รายการบริการทั้งหมด
                 │                                        │
   บริการที่ยังว่างในวันนั้น            ปฏิทิน: วันไหนบริการนี้ว่าง
   (ที่เต็มเป็นสีเทา + เหตุผล)                         │
                 │                                        │
                 └─────────► เลือกเวลา (+ ช่าง) ◄─────────┘
                                     │
                         ข้อมูลลูกค้า → (ชำระเงิน) → ยืนยัน
```

- ทุกทางต้องเลือก**ครบชุดเดียวกัน** (`require`: บริการ + วันที่ + เวลา) ต่างกันแค่ลำดับ
- ทุกขั้นถามเครื่องคำนวณตัวเดียว (ข้อ 6) ตัวเลือกที่เห็นจึงเป็นของที่จองได้จริงเสมอ
- **ตัวเลือกที่ไม่ว่างแสดงเป็นสีเทาพร้อมเหตุผล** ("เต็ม", "ร้านปิด", "ช่างหยุด") ไม่ซ่อน ลูกค้าจะไม่สงสัยว่าหายไปไหน
- ปุ่มลัด **"วันนี้ / พรุ่งนี้"** บนปฏิทิน
- `entry` มีตัวเดียว = ไม่มีหน้าเลือกทาง เริ่มขั้นนั้นทันที (เช่น ร้านตัดผมที่อยากให้เลือกบริการก่อนเสมอ)

### ลำดับขั้นหลังเลือกทางเริ่ม

ระบบเรียงให้เอง: ขั้นที่ยังไม่เลือกใน `require` + `optional` ตามลำดับนี้ โดยข้ามขั้นที่เลือกแล้ว
`offering → resource → date → time → duration → party` แล้วต่อด้วย `then`

| เริ่มจาก | ลำดับที่ลูกค้าเห็น (ร้านเสริมสวยตัวอย่าง) |
|---|---|
| วันที่ | วันที่ → บริการ → ช่าง → เวลา → ข้อมูลลูกค้า |
| บริการ | บริการ → ช่าง → วันที่ → เวลา → ข้อมูลลูกค้า |

### ลูกค้าย้อนกลับไปเปลี่ยนตัวเลือก

เมื่อเปลี่ยนขั้นใดขั้นหนึ่ง ระบบถามเครื่องคำนวณใหม่ว่าตัวเลือกที่เลือกไว้ในขั้นอื่นยังเป็นไปได้ไหม

- **ยังได้** → คงไว้ (เช่น เปลี่ยนวัน บริการเดิมยังว่าง → คงบริการ ล้างแค่เวลา)
- **ไม่ได้แล้ว** → ล้างขั้นนั้น พร้อมบอกเหตุผล: "ทำสีผมไม่ว่างวันที่ 28 กรุณาเลือกใหม่"
- เวลาถูกล้างเสมอเมื่อเปลี่ยนวัน บริการ หรือช่าง · เลือกระยะเวลา/จำนวนคน**หลัง**เวลา (สนาม: เวลา → จำนวนชั่วโมง) เวลาเดิมคงไว้ถ้ายังจองได้

### ขั้นที่มีให้ตั้ง

| ขั้น | ลูกค้าเลือกอะไร | หมายเหตุ |
|---|---|---|
| `offering` | บริการ | |
| `resource` | ทรัพยากรที่ `customer_picks = true` เช่น ช่าง | มี "ใครก็ได้" ถ้าร้านเปิด `show_any_staff` |
| `date` | วันที่ | ปฏิทิน มีจุดบอกวันที่ยังว่าง |
| `time` | เวลาเริ่ม | |
| `duration` | ระยะเวลา | เฉพาะบริการ `customer_choice` |
| `party` | จำนวนคน | เฉพาะบริการ `max_party_size > 1` |
| `customer` | ชื่อ เบอร์ (LIFF เติมให้) | อยู่ใน `then` เสมอ |
| `payment` | มัดจำ/ชำระ | ถ้าบริการต้องชำระก่อน |

กติกาที่ฐานข้อมูลตรวจตอนร้านบันทึก (check constraint ใน `booking_flows`):
`require` ต้องมี `date` และ `time` · ทางเริ่มต้องเป็นขั้นที่ลูกค้าเลือกอยู่แล้ว ·
`then` ต้องมี `customer` · ขั้นหนึ่งอยู่ได้ทั้ง `require` หรือ `optional` อย่างใดอย่างหนึ่ง ·
ขั้นที่ไม่เกี่ยวกับบริการที่เลือก (เช่น `duration` กับบริการ fixed) ระบบข้ามให้เอง

### ตัวอย่างการตั้งค่า

```jsonc
// ร้านเสริมสวย (seed: bloom-hair): เริ่มจากวันหรือบริการก็ได้ เลือกช่างหรือ "ใครก็ได้"
{ "entry": ["date", "offering"], "require": ["offering", "date", "time"], "optional": ["resource"],
  "then": ["customer"], "options": { "show_any_staff": true, "date_range_days": 30 } }

// ร้านตัดผมชาย (seed: gentleman-barber): เริ่มจากบริการเสมอ ระบบเลือกช่างที่ว่างให้
{ "entry": ["offering"], "require": ["offering", "date", "time"], "optional": [],
  "then": ["customer"], "options": { "date_range_days": 14 } }

// สนามกีฬา (ภายหลัง): เริ่มจากสนาม แล้วเลือกวัน เวลา จำนวนชั่วโมง
{ "entry": ["resource"], "require": ["offering", "resource", "date", "time", "duration"], "optional": [],
  "then": ["customer", "payment"], "options": { "date_range_days": 7 } }
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

**ที่ทำจริงแล้ว (ขั้นที่ 2)** — `src/v2/options-engine.js`, ทดสอบใน `tests/v2-options-engine.test.js`:

| ฟังก์ชัน | ทำอะไร |
|---|---|
| `getOptions(catalog, { ask, selected, now })` | ตัวเลือกของขั้นที่ถาม พร้อม `available` / `reason` · ค่าของขั้นที่ถามใน `selected` ถูกละไว้ (ใช้ตอนเปลี่ยนได้เลย) |
| `nextStep(catalog, { selected, now })` | ขั้นถัดไป: `start` (หน้าเลือกทางเริ่ม) → ขั้นตาม flow → `then` · ข้ามขั้นที่ไม่เกี่ยว (ช่างที่ลูกค้าเลือกไม่ได้, duration ของบริการ fixed, จำนวนคนของบริการ 1 คน) |
| `reconcile(catalog, { selected, changed, now })` | หลังลูกค้าเปลี่ยนขั้น `changed`: คงตัวเลือกที่ยังได้ ล้างตัวที่ไม่ได้พร้อมเหตุผล · เวลาถูกล้างเสมอ · ตรวจตามลำดับขั้น จึงล้าง "ช่างที่หยุดวันนั้น" ไม่ใช่ "บริการ" |

- `catalog` = แถวจากตารางขั้นที่ 1 ของร้านเดียว + `busy` (แถว `booking_resources` ที่ active, `end_at` รวม buffer แล้ว) ·
  hold ที่หมดอายุไม่นับ · `excludeBookingId` ใช้ตอนเลื่อนนัด
- `resourceId: null` = ลูกค้าเลือก "ใครก็ได้" · `undefined` = ยังไม่ได้ถาม
- `ask: "time"` คืนเฉพาะเวลาที่จองได้ (ทุกช่อง 15 นาทีเป็นสีเทาจะรกเกินไป) ถ้าว่างเปล่ามี `reason` ระดับบนบอกเหตุผล
- เวลาเริ่มเรียงตามเวลาเปิดร้านทีละ `slot_interval_minutes` · บริการต้องจบภายในเวลาทำงาน ส่วน buffer หลังจบเลยเวลาปิดได้
- เหตุผลเพิ่มจากชุดเดิม 2 ตัว: `OUTSIDE_BOOKING_WINDOW` (ก่อนวันนี้/เกิน `max_advance_days`), `NOT_OFFERED` (ช่างที่เลือกไม่ทำบริการนี้)
- ยังไม่มี: คิดราคา (ทำพร้อม `create_booking` ขั้นที่ 3) และ API route `/api/b/{slug}/options` (ทำพร้อมหน้าจองขั้นที่ 4)

### ตอนกดยืนยัน (ทำแล้วในขั้นที่ 3: `supabase/migrations/20261025000300_booking_rpcs.sql`)

`create_booking` (RPC `security definer`) **คำนวณซ้ำฝั่งฐานข้อมูล** ไม่เชื่อค่าจากหน้าเว็บ:
ตรวจขั้นที่ flow บังคับครบ → เลือกทรัพยากรที่ว่าง (กรณี "ใครก็ได้") → คิดราคา → insert `bookings` + `booking_resources`
ถ้า constraint หรือการตรวจความจุไม่ผ่าน ตอบ `CONFLICT` (หน้าจอแสดง "ช่วงเวลานี้เพิ่งถูกจอง" แบบที่ repo มีอยู่แล้ว)

| RPC | ทำอะไร |
|---|---|
| `create_booking(business_id, offering_id, start_at, customer jsonb, resource_id?, duration?, party?, hold?, source?, notes?)` | ตรวจช่องนั้นซ้ำทั้งหมด เลือกทรัพยากร (กรณี "ใครก็ได้" เอาตัวแรกที่ว่างตาม `sort_order`) คิดราคา หา/สร้างลูกค้า (LINE ID แล้วเบอร์) · `hold = true` → `held` ถึง `hold_minutes` |
| `reschedule_booking(booking_id, start_at, resource_id?, duration?)` | ไม่นับตัวเองเป็นคิวชน · **คงช่างที่ลูกค้าเลือกไว้** ถ้าไม่ระบุใหม่ (ร้านที่ระบบเลือกช่างให้ ย้ายไปช่างที่ว่างได้) |
| `confirm_booking(booking_id)` | `held` → `confirmed` (จ่ายเงินแล้ว) · hold หมดเวลาแล้วตอบ `HOLD_EXPIRED` |
| `cancel_booking(booking_id, reason?)` | ปล่อยคิวทันที เรียกซ้ำได้ไม่ error |
| `expire_holds(business_id?)` | ปล่อย hold ที่หมดเวลา · RPC ข้างบนเรียกเองทุกครั้ง และเครื่องคำนวณคิวว่างไม่นับ hold ที่หมดเวลา จึงยังไม่ต้องใช้ pg_cron |

- error มีรหัสใน `message`: `BK409` = เพิ่งถูกจอง (`FULLY_BOOKED`, `HOLD_EXPIRED`) · `BK422` = จองแบบนี้ไม่ได้
  (`BUSINESS_CLOSED`, `STAFF_OFF`, `NOT_OFFERED`, `NO_WORKING_WINDOW`, `PAST_WORKING_HOURS`, `OUTSIDE_BOOKING_WINDOW`,
  `INVALID_TIME`, `INVALID_DURATION`, `INVALID_PARTY_SIZE`, `CUSTOMER_NAME_REQUIRED`, `NOT_CHANGEABLE`) · `BK404` = ไม่พบ
- เรียกได้: สมาชิกร้าน (เฉพาะร้านตัวเอง) และ service role · `source = 'admin'` ข้าม lead time และช่องเวลา 15 นาที
- ประวัติสถานะเขียนด้วย trigger ทุกเส้นทาง (เหตุผลยกเลิก/หมดเวลา hold อยู่ใน `reason`)
- ราคา `booking_price`: กฎที่เจาะจงกว่าชนะ · `per_hour` คิดทีละนาที (16:00–18:00 ข้ามราคา 17:00 = 300 + 450)
- ทดสอบใน `supabase/tests/booking-rpc.test.js` (`npm run test:db`): จองพร้อมกัน 2 คน, คลาส 12 คน, hold หมดเวลา, เลื่อน, ยกเลิก, ราคา, เหตุผลทุกแบบ

---

### หน้าจอง (ทำแล้วในขั้นที่ 4)

| ส่วน | ไฟล์ |
|---|---|
| หน้าเว็บ `/b/<slug>` (มือถือก่อน, เปิดใน LIFF ได้) | `app/b/[slug]/page.jsx`, `booking-v2-client.jsx`, `booking-v2.css` |
| `GET /api/b/<slug>` ข้อมูลร้าน บริการ ราคาเริ่มต้น ช่างที่เลือกได้ | `app/api/b/[slug]/route.js` |
| `POST /api/b/<slug>/step` `{ selected, changed?, ask? }` → `{ selected, cleared, next, ask, options, reason }` | `app/api/b/[slug]/step/route.js` |
| `POST /api/b/<slug>/bookings` `{ selected, customer, lineIdToken? }` → เรียก `create_booking` | `app/api/b/[slug]/bookings/route.js` |
| ตรรกะทั้งหมด (ทดสอบกับฐานข้อมูลได้โดยไม่ต้องเปิดเซิร์ฟเวอร์) | `src/v2/public-booking.js`, `catalog-repository.js`, `db.js` |

- เซิร์ฟเวอร์เป็นคนตัดสินว่าขั้นต่อไปคืออะไร หน้าเว็บแค่แสดง · กดชิปด้านบนเพื่อเปลี่ยนขั้นที่เลือกไปแล้ว
- ตอน**แก้**บริการหรือวัน รายการไม่ถูกจำกัดด้วยช่างที่เลือกไว้ (ไม่งั้นเปลี่ยนจากทำสีไปตัดผมไม่ได้เพราะช่างพลอยทำสีอย่างเดียว) ·
  ถ้าช่างใช้ไม่ได้กับตัวเลือกใหม่ จะถูกล้างพร้อมบอกเหตุผล
- จองชน (409) → บอก "เพิ่งถูกจอง" แล้วพากลับไปเลือกเวลา โดยคงตัวเลือกอื่นไว้
- จำกัดจำนวนครั้งต่อ IP ในฐานข้อมูล (`hit_rate_limit`, migration `…000400`): หน้า 120/นาที, step 240/นาที, จอง 5 ครั้ง/10 นาที
- LIFF: ตั้ง `NEXT_PUBLIC_LIFF_ID` แล้วหน้าเว็บเติมชื่อจาก LINE และส่ง ID token · เซิร์ฟเวอร์ตรวจกับ LINE ด้วย `LINE_LOGIN_CHANNEL_ID`
  แล้วผูก `customers.line_user_id` (LIFF ตัวเดียวของแพลตฟอร์มใช้ได้ทุกร้าน เพราะ URL มี slug)
- environment ที่ต้องตั้งบน **Railway** (service `salon-booking-os-v1` ที่ deploy repo นี้ด้วย Dockerfile อยู่แล้ว):
  `BOOKING_DB_URL` (Supabase → Connect → **Session pooler** เพราะ Railway เป็นเซิร์ฟเวอร์ที่รันตลอด), `BOOKING_DB_CA` (ใบรับรองจาก
  Database → SSL ถ้าไม่ใส่ = เข้ารหัสแต่ไม่ตรวจใบรับรอง), และถ้าใช้ LIFF: `NEXT_PUBLIC_LIFF_ID`, `LINE_LOGIN_CHANNEL_ID`
- ทดสอบ: `supabase/tests/public-api.test.js` (`npm run test:db`) และ `e2e/booking-v2.spec.cjs` (Playwright, วิธีรันอยู่หัวไฟล์)

### หน้าแอดมิน (ทำแล้วในขั้นที่ 5)

| ส่วน | ไฟล์ |
|---|---|
| `/dashboard` เข้าสู่ระบบ / สมัคร / ลืมรหัสผ่าน (Supabase Auth) · รายชื่อร้าน · เปิดร้านใหม่ | `app/dashboard/page.jsx`, `dashboard-home-client.jsx` |
| `/dashboard/<slug>` 4 แท็บ: ขั้นตอนจอง (มีพรีวิว), บริการและราคา, ช่าง/สนาม (ตารางงาน วันลา), ร้านและเวลาทำการ (วันหยุดร้าน กติกาการจอง) | `app/dashboard/[slug]/shop-admin-client.jsx`, `flow-preview.mjs` |
| `GET/POST/DELETE /api/dashboard/session` · `GET/POST /api/dashboard/shops` · `/api/dashboard/shops/<slug>[/resources\|offerings\|closures\|time-off\|flow][/<id>]` | `app/api/dashboard/**` |
| ล็อกอิน: cookie httpOnly, ต่ออายุ token เอง, ถาม Supabase ว่า token เป็นของใคร (cache 1 นาที) | `src/v2/admin-auth.js` |
| อ่าน/บันทึกข้อมูลร้าน (ตรวจค่า + ข้อความภาษาไทย) | `src/v2/admin-catalog.js`, `admin-routes.js` |

- **สิทธิ์ใช้ RLS ของขั้นที่ 1 โดยตรง**: เซิร์ฟเวอร์รันทุกคำขอเป็น role `authenticated` พร้อม id ผู้ใช้ (`set local role` +
  `request.jwt.claims` ใน transaction เดียว) ร้าน A จึงอ่าน/แก้ร้าน B ไม่ได้แม้โค้ดฝั่งเซิร์ฟเวอร์ผิด · พนักงาน (`staff`) ดูได้อย่างเดียว
- หน้าเว็บล็อกอินกับ Supabase Auth ตรง (rate limit ของ Supabase นับต่อเครื่องเจ้าของร้าน ไม่ใช่ต่อเซิร์ฟเวอร์) แล้วส่ง session ให้ `/api/dashboard/session` เก็บเป็น cookie
- ลบช่าง/สนาม/บริการที่มีการจองแล้วไม่ได้ ระบบ**ปิดไว้แทน** (ประวัติการจองยังเห็นชื่อ)
- ชนิดทรัพยากรตั้งชื่อเองได้ (migration `…000600`) เช่น "เก้าอี้นวด" · บริการจับคู่ทรัพยากรด้วยชื่อชนิดนี้ และหน้าจองใช้เป็นคำว่า "เลือกเก้าอี้นวด"
- **แท็บ "การจอง"** (แท็บแรก, พนักงานใช้ได้ด้วย): รายการจองรายวัน · ร้านเพิ่มการจองเอง (โทรมา/walk-in, ไม่ติด lead time, พิมพ์เวลาเองได้ พร้อมปุ่มเวลาที่ว่าง) · เลื่อน · ยกเลิกพร้อมเหตุผล · มาถึงแล้ว / เสร็จแล้ว / ไม่มา (`set_booking_status`, migration `…000700`) · `src/v2/admin-bookings.js`, ทดสอบใน `supabase/tests/admin-bookings.test.js`
- **บันทึกการจองย้อนหลัง** (migration `…000800`): ในฟอร์ม "เพิ่มการจอง" ถ้าเวลาเริ่มผ่านไปแล้ว จะเลือกได้ว่า ใช้บริการแล้ว / กำลังใช้บริการ / ไม่มา
  แล้วเรียก `record_past_booking` · ย้อนได้ไม่เกิน 1 ปี · ยังตรวจเวลาทำการ ตารางช่าง และกันจองซ้อนเหมือนเดิม (ไม่มา = ไม่กันช่าง) ·
  ประวัติสถานะเขียนเหตุผล "บันทึกย้อนหลัง" และรายการจองแสดง "(ย้อนหลัง)"
- พรีวิวขั้นตอนจอง: ลำดับขั้นของแต่ละทางเริ่ม (คิดแบบเดียวกับ `nextStep`) + คำเตือนสิ่งที่ทำให้ลูกค้าจองไม่ได้
  (บริการไม่มีราคา, ไม่มีช่างที่ทำบริการ, บริการให้เลือกระยะเวลาแต่ flow ไม่มีขั้นนั้น) + หน้าจองจริงในกรอบมือถือ · มีแบบสำเร็จรูป 4 แบบ
- ขั้น `payment` ยังเลือกไม่ได้ (รอขั้นที่ 6) เพราะทุกการจองจะเป็น hold แล้วหมดอายุ
- environment บน Railway: `SUPABASE_URL` (`https://<ref>.supabase.co`) และ `SUPABASE_PUBLISHABLE_KEY` (Settings → API Keys, เป็นค่าสาธารณะ) ·
  Supabase → Authentication → URL Configuration: ใส่ `https://<โดเมน>/dashboard` ใน Site URL / Redirect URLs (ลิงก์ยืนยันอีเมลและลืมรหัสผ่าน)
- ทดสอบ: `supabase/tests/admin.test.js` (`npm run test:db`: สิทธิ์ owner/staff/ข้ามร้าน, ร้านใหม่ตั้งสนามเองแล้วลูกค้าจองได้ราคา 300 + 450, ปิดแทนลบ, ตรวจค่า)
  และ `tests/v2-admin-auth.test.js` (cookie, ต่ออายุ token, token ปลอม)

### ลูกค้ายกเลิก/เลื่อนนัดเอง

| ส่วน | ไฟล์ |
|---|---|
| หลังจองสำเร็จ หน้าจองแสดงลิงก์ `/b/<slug>/manage/<token>` (ปุ่ม "ดูการจองของฉัน" + คัดลอกลิงก์) | `app/b/[slug]/booking-v2-client.jsx` |
| หน้าการจองของลูกค้า: ดูรายละเอียด · เลื่อนนัด (วัน → เวลาที่ว่าง ช่างคนเดิม) · ยกเลิกพร้อมเหตุผล | `app/b/[slug]/manage/[token]/*` |
| `GET /api/b/<slug>/manage/<token>` · `POST …/options` `{ ask: date \| time, date? }` · `POST …/reschedule` `{ date, time }` · `POST …/cancel` `{ reason? }` | `app/api/b/[slug]/manage/[token]/**`, `src/v2/manage-booking.js` |
| กติกาของร้าน: ให้เลื่อนเองได้ไหม · ให้ยกเลิกเองได้ไหม · ทำได้ถึงกี่ชั่วโมงก่อนนัด (ค่าเริ่มต้น เปิดทั้งคู่ ถึง 2 ชม.) | แท็บ "ร้านและเวลาทำการ", migration `…000900` |

- ลิงก์มี token สุ่ม 192 บิต ฐานข้อมูลเก็บแค่ sha256 (`bookings.manage_token_hash`) และผูกตอนสร้างการจองในคำสั่งเดียวกัน
  (`booking_attach_manage_token(create_booking(...))`) · การจองที่ร้านบันทึกเองไม่มีลิงก์
- ฐานข้อมูลตรวจกติกาซ้ำทุกครั้ง (`customer_cancel_booking`, `customer_reschedule_booking` เรียกได้เฉพาะ service role) ·
  เลื่อนต้องผ่าน lead time และช่วงเวลาเริ่มของร้านเหมือนจองใหม่ · ยกเลิกแล้วบันทึกเหตุผล "ลูกค้ายกเลิกเอง: …" ร้านเห็นในรายการจอง
- หน้าไม่ให้ search engine เก็บ และไม่ส่ง Referer (token อยู่ใน URL) · จำกัดคำขอ: ดู 60/นาที, เปลี่ยน 10 ครั้ง/10 นาที ต่อ IP
- ทดสอบ: `supabase/tests/manage-booking.test.js` และ Playwright ข้อสุดท้ายใน `e2e/booking-v2.spec.cjs`
- ขั้นที่ 6: ปุ่ม "เลื่อนนัด" / "ยกเลิก" ในการ์ด LINE เปิดหน้านี้ได้เลย (ออก token ใหม่ให้การจองตอนส่งการ์ด)

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
| `STEPS` ตายตัว | `booking_flows` ค่าเริ่มต้น: เริ่มจากวันหรือบริการ, ต้องเลือก บริการ+วัน+เวลา, ช่างเลือกหรือไม่ก็ได้ |
| login แอดมินของตัวเอง (`src/security/*`) | Supabase Auth + `business_members` |

ข้อมูลทดสอบใน `SEED_DATA.sql` ย้ายเป็น seed ของร้านตัวอย่าง 3 ร้าน (เสริมสวย, สปา, สนาม) ใช้ทั้งทดสอบและเดโม

---

## 9. ลำดับการทำ

| ขั้น | งาน | เสร็จเมื่อ |
|---|---|---|
| 1 ✅ | migration ใน `supabase/migrations/`: businesses, members, resources, ตารางเวลา, offerings, requirements, price_rules, flows, customers, bookings, booking_resources + RLS ทุกตาราง · seed ร้านเสริมสวย + ร้านตัดผม | `npm run test:db` 16/16: anon อ่านอะไรไม่ได้, ร้าน A อ่าน/เขียนร้าน B ไม่ได้, staff แก้ catalog ไม่ได้, FK กันอ้างข้ามร้าน, กันจองช่างซ้อน, flow ที่จองไม่จบถูกปฏิเสธ |
| 2 ✅ | เครื่องคำนวณ `getOptions` (ตรรกะล้วน) ย้ายมาจาก `availability-engine.js` | unit test ทั้ง 2 ร้านตัวอย่าง (+ สนามภายหลัง): ทุก `ask` ทุกทางเริ่ม, การย้อนกลับไปเปลี่ยนตัวเลือก, ความจุ > 1, buffer, ระยะเวลาให้ลูกค้าเลือก |
| 3 ✅ | RPC `create_booking` / `reschedule_booking` / `cancel_booking` + hold หมดอายุ | ทดสอบจองพร้อมกัน 2 คนช่องเดียว → สำเร็จ 1 อีกคนได้ `CONFLICT` · คลาสความจุ 12 รับคนที่ 13 ไม่ได้ |
| 4 ✅ | หน้าจองอ่าน flow (เว็บ + LIFF) พร้อมหน้าเลือกทางเริ่ม | จองได้ทั้งสองทางเริ่มของร้านเสริมสวย และ flow ร้านตัดผม (Playwright) |
| 5 ✅ | หน้าแอดมิน: ทรัพยากร, บริการ, ราคา, ขั้นตอนจอง (มีตัวอย่างพรีวิว) | ร้านตั้ง flow สนามเองได้โดยไม่ต้องแก้โค้ด (`admin.test.js` + ลองในเบราว์เซอร์) |
| 6 | LINE, แบรนด์/สาขา, คะแนนสะสม, ย้ายชำระเงิน — แบ่งเป็น 6a–6f ใน `docs/LOYALTY_DESIGN.md` | การ์ด LINE ยืนยัน/เตือนนัดใช้ได้กับทั้ง 3 ร้าน · ลูกค้าได้และใช้คะแนนข้ามสาขาได้ |
| 6+ | **ตัวเลือกเสริม (add-on) + การจองหลายวัน** — แบบระบบข้อ 11 (รอเจ้าของตอบข้อ 11.9) | ตามตารางข้อ 11.10 |
| 7 | (ภายหลัง) Jev สำหรับแชท · ราคา peak ซับซ้อน · จองซ้ำทุกสัปดาห์ · waitlist | — |

---

## 10. คำถามที่ต้องตอบก่อน/ระหว่างทำ

1. ~~กลุ่มลูกค้าแรก~~ → ร้านเสริมสวย และร้านตัดผมชาย
2. ~~หลายสาขา~~ → สาขา = `businesses` แต่ละแถว อยู่ใต้ **แบรนด์** (`brands`) เดียวกัน · คะแนนสะสมใช้ข้ามสาขาได้ (ดู `docs/LOYALTY_DESIGN.md`)
3. ~~มัดจำ~~ → โอนเงิน + แนบสลิป + ร้านยืนยัน (#39) · ตั้ง**ต่อร้าน** (ต่อบริการภายหลังถ้ามีคนขอ) · ไม่ส่งสลิปภายใน `hold_minutes` = ปล่อยคิวอัตโนมัติ · ส่งสลิปแล้วรอร้านตัดสิน ไม่หมดเวลา
4. ~~นโยบายยกเลิก/เลื่อน~~ → ตั้งต่อร้าน: เปิด/ปิดการเลื่อน และการยกเลิกแยกกัน + ทำได้ถึงกี่ชั่วโมงก่อนนัด (ต่อบริการ: ภายหลังถ้ามีคนขอ)
5. ~~ลูกค้าต้องมีบัญชีไหม~~ → เว็บใช้แค่ชื่อ+เบอร์ (ไม่มีประวัติ/คะแนน) · บัญชีลูกค้า = **LINE อย่างเดียว** ไม่ทำ OTP (ดู `docs/LOYALTY_DESIGN.md`)
6. ~~repo~~ → ทำต่อใน repo นี้

---

## 11. ตัวเลือกเสริม (add-on) และการจองหลายวัน — แบบระบบ (ยังไม่ได้ทำ)

สถานะ: **ลูกค้าจองพร้อมตัวเลือกเสริมได้แล้ว** · A (ตาราง + หน้าตั้งค่า) #37 · B+C (เครื่องคำนวณ + การจอง + ราคา + หน้าจอง) #38 · มัดจำโอนเงิน (M) #39 · ยังไม่ทำ: เลือกตัวเลือกเสริมในฟอร์มเพิ่มการจองของร้าน, แพ็กเกจ (D), หลายวัน (E)

**ตัดสินแล้ว:** ธุรกิจแรกที่ใช้ตัวเลือกเสริม = **สนามกีฬา** (เช่าอุปกรณ์ เช่น ไม้ ลูก) · มัดจำรุ่นแรก = **โอนเงิน** ·
ของที่ลูกค้าเอาไปใช้ข้างนอก (รถ กล้อง มือถือ) ทำทีหลัง พร้อม**เอกสารประกอบการเช่า** ระบบสมาชิก และคะแนนสะสม

เป้าหมาย: ระบบเดียวใช้ได้กับทุกธุรกิจที่ "จองของที่มีจำกัดตามช่วงเวลา" แล้ว**เลือกของเสริมได้**
โดยไม่ต้องเขียนโค้ดต่อธุรกิจ

| ธุรกิจ | ตัวอย่างตัวเลือกเสริม |
|---|---|
| ร้านเสริมสวย | ทรีตเมนต์เพิ่ม (+15 นาที, +200 บาท) · สระเพิ่ม |
| สนามกีฬา | เช่าไม้ (ต่อชิ้น) · ลูกแบด (ต่อหลอด) · ห้องอาบน้ำ |
| เช่ารถ | ประกัน (เลือกได้ 1 แบบ) · เติมน้ำมันเต็มถัง · **คนขับ** (ต้องว่าง) · คาร์ซีท (มี 3 ตัว เลือกได้ 2) |
| ทัวร์ / คลาส | อาหารกลางวัน (ต่อคน) · รถรับส่ง |

### 11.1 ของเดิมที่ใช้ได้เลย (ไม่ต้องทำเพิ่ม)

- ทรัพยากรหลายชนิดต่อ 1 บริการ (`offering_requirements`): "ทัวร์พร้อมคนขับ" ที่**ต้อง**มีคนขับเสมอ = รถ 1 + คนขับ 1 ทำได้แล้ว
- ชื่อชนิดทรัพยากรตั้งเองได้ (`…000600`): "รถตู้", "คนขับ", "คาร์ซีท"
- ความจุ > 1: ของที่มีหลายชิ้นแต่ไม่แยกชิ้น (คาร์ซีท 3 ตัว) = ทรัพยากร 1 ตัว `capacity = 3`
- กันชนที่ฐานข้อมูล (`booking_resources` + exclusion constraint / advisory lock) ใช้กับของเสริมที่ต้องว่างได้ทันที

**ที่ยังไม่มี:** ของที่ลูกค้า*เลือกเองว่าจะเอาหรือไม่* (ทุกอย่างใน `offering_requirements` เป็นของบังคับ) และการจองข้ามวัน

### 11.2 แนวคิด: ตัวเลือกเสริม 1 แบบ ทำงานได้ 3 อย่าง

ตัวเลือกเสริมแต่ละตัวมีราคา และ**ทำอย่างใดอย่างหนึ่งหรือหลายอย่าง**ต่อไปนี้ได้:

| ทำอะไร | ตั้งที่ | ตัวอย่าง | ระบบต้องตรวจ |
|---|---|---|---|
| บวกราคาอย่างเดียว | `amount` + `price_unit` | เติมน้ำมัน, ประกัน | — |
| เพิ่มเวลา | `adds_minutes` | ทรีตเมนต์ +15 นาที | ช่าง/ห้องต้องว่างพอถึงเวลาที่ยาวขึ้น |
| ใช้ทรัพยากรเพิ่ม | `uses_kind` (+ จำนวนตาม `quantity`) | คนขับ 1 คน · คาร์ซีท 2 ตัว | ทรัพยากรชนิดนั้นต้องว่าง (ระบบเลือกตัวที่ว่างให้) |

ตัวเลือกอยู่ใน**กลุ่ม** และกลุ่มกำหนดว่าเลือกได้กี่อย่าง:
- "ประกันภัย" ต้องเลือก 1 (`min 1, max 1`) → ปุ่มเลือกแบบวงกลม
- "ของเสริม" เลือกได้หลายอย่าง (`min 0, max ไม่จำกัด`) → ช่องติ๊ก / ปุ่ม + − สำหรับของที่มีจำนวน

กลุ่มหนึ่งใช้กับหลายบริการได้ (รถทุกรุ่นใช้กลุ่ม "ประกันภัย" เดียวกัน) จึงผูกผ่านตารางเชื่อม

### 11.3 ตาราง (ร่าง)

```sql
create table addon_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,                    -- "ประกันภัย", "ของเสริม"
  min_select int not null default 0,     -- 1 = ต้องเลือก
  max_select int,                        -- null = ไม่จำกัด · 1 = เลือกได้อย่างเดียว
  sort_order int not null default 0,
  unique (id, business_id),
  check (min_select >= 0 and (max_select is null or max_select >= greatest(min_select, 1)))
);

-- กลุ่มไหนใช้กับบริการไหน (ทั้งสองฝั่งต้องเป็นร้านเดียวกัน แบบ offering_resources)
create table offering_addon_groups (
  business_id uuid not null,
  offering_id uuid not null,
  group_id uuid not null,
  primary key (offering_id, group_id),
  foreign key (offering_id, business_id) references offerings(id, business_id) on delete cascade,
  foreign key (group_id, business_id) references addon_groups(id, business_id) on delete cascade
);

create table addons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  group_id uuid not null,
  name text not null,
  description text,
  media jsonb not null default '[]',
  price_unit text not null default 'per_booking'
    check (price_unit in ('per_booking','per_hour','per_day','per_person','per_unit')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  max_quantity int not null default 1 check (max_quantity >= 1),   -- > 1 = มีปุ่ม + −
  adds_minutes int not null default 0 check (adds_minutes >= 0),
  uses_kind text,                        -- null = ไม่ใช้ทรัพยากร
  active boolean not null default true,
  sort_order int not null default 0,
  unique (id, business_id),
  foreign key (group_id, business_id) references addon_groups(id, business_id) on delete cascade
);

-- สิ่งที่การจองเลือกไว้ คัดลอกชื่อและราคาไว้ แบบ price_snapshot (ร้านแก้ราคาทีหลัง การจองเก่าไม่เปลี่ยน)
create table booking_addons (
  business_id uuid not null,
  booking_id uuid not null,
  addon_id uuid not null,
  quantity int not null default 1 check (quantity >= 1),
  name text not null,
  total numeric(12,2) not null,
  primary key (booking_id, addon_id),
  foreign key (booking_id, business_id) references bookings(id, business_id) on delete cascade,
  foreign key (addon_id, business_id) references addons(id, business_id)
);
```

- RLS แบบเดียวกับ catalog: สมาชิกร้านอ่านได้ · เจ้าของร้านแก้ได้ · anon อ่านไม่ได้ (หน้าจองอ่านผ่าน API ฝั่งเซิร์ฟเวอร์)
- `booking_addons` เขียนผ่าน RPC จองเท่านั้น
- ทรัพยากรที่ตัวเลือกเสริมใช้ (คนขับ, คาร์ซีท) ลงใน `booking_resources` เหมือนทรัพยากรหลัก
  → กันชนด้วยกลไกเดิม ไม่ต้องเขียนใหม่ · แถวมี `addon_id` เพิ่ม (null = ทรัพยากรหลัก) เพื่อให้หน้าจอแยกแสดงได้

### 11.4 ราคา

`price_snapshot` เพิ่ม `lines` แยกรายการ (บิลยังเก็บแค่ยอดรวม จึงใช้ `lines` นี้แสดงรายละเอียดในบิล):

```jsonc
{ "unit": "per_hour", "amount": 300, "total": 1150,
  "lines": [
    { "kind": "offering", "name": "สนาม 2", "total": 900 },
    { "kind": "addon", "addon_id": "…", "name": "เช่าไม้", "quantity": 2, "unit": "per_unit", "amount": 50, "total": 100 },
    { "kind": "addon", "addon_id": "…", "name": "ห้องอาบน้ำ", "quantity": 1, "unit": "per_booking", "amount": 150, "total": 150 }
  ] }
```

| `price_unit` | คิดยังไง |
|---|---|
| `per_booking` | `amount × quantity` |
| `per_hour` | `amount × นาทีทั้งหมด ÷ 60 × quantity` (นาทีรวม `adds_minutes` แล้ว) |
| `per_day` | `amount × จำนวนวัน × quantity` (วัน = ข้อ 11.7 · การจองภายในวันเดียว = 1 วัน) |
| `per_person` | `amount × party_size` |
| `per_unit` | `amount × quantity` |

ราคาตัวเลือกเสริมเป็นราคาเดียว ไม่แยกตามวัน/เวลา (`price_rules` แบบละเอียดของบริการยังใช้กับบริการเท่านั้น) · ต้องการภายหลังค่อยเพิ่ม

### 11.5 ขั้นในหน้าจอง และเครื่องคำนวณคิวว่าง

- ขั้นใหม่ **`addons`** ("ตัวเลือกเพิ่มเติม") · ค่าเริ่มต้นอยู่หลังเลือกเวลา ก่อนกรอกข้อมูล: `"then": ["addons", "customer"]`
  · บริการที่ไม่มีกลุ่มตัวเลือก ระบบข้ามขั้นนี้ให้เอง (แบบ `duration` ของบริการ fixed)
- `selected.addons = { "<addon_id>": จำนวน }` · `undefined` = ยังไม่ถึงขั้นนี้ · `{}` = ไม่เอาอะไร
- `getOptions({ ask: "addons" })` คืนทุกตัวเลือกของบริการนั้น พร้อม `available` / `reason`:
  - `RESOURCE_BUSY` — คนขับ/คาร์ซีทไม่ว่างช่วงเวลานั้น (ความจุ > 1 บอกจำนวนที่เหลือใน `remaining`)
  - `NOT_ENOUGH_TIME` — `adds_minutes` ทำให้เกินเวลาทำงานของช่าง หรือชนคิวถัดไป
- ถ้าร้านอยากให้เลือกตัวเลือกเสริม*ก่อน*เลือกเวลา (เช่น ทรีตเมนต์ +15 นาที อยากให้เห็นเวลาที่พอดี) ย้าย `addons` ไปไว้ใน `require` ได้ ·
  เครื่องคำนวณนับ `adds_minutes` และทรัพยากรของตัวเลือกที่เลือกแล้วตอนหาเวลาว่าง
- **ย้อนกลับไปเปลี่ยน** (`reconcile`): เปลี่ยนวัน/เวลา/บริการแล้ว ตัวเลือกที่ใช้ไม่ได้จะถูกเอาออกพร้อมข้อความ
  "คนขับไม่ว่างช่วงเวลาใหม่ — นำออกแล้ว" · ตัวเลือกของบริการเดิมถูกล้างเมื่อเปลี่ยนบริการ
- **ยืนยันการจอง**: `create_booking` รับ `p_addons jsonb` แล้วตรวจซ้ำทั้งหมดฝั่งฐานข้อมูล (ของร้านนี้, ผูกกับบริการนี้, active,
  จำนวนไม่เกิน, ครบ min/max ของกลุ่ม) → ยืด `end_at` ตาม `adds_minutes` → เลือกทรัพยากรที่ว่าง → คิดราคา → insert
  · error ใหม่: `BK409 ADDON_UNAVAILABLE` (เพิ่งถูกจองไป) · `BK422 ADDON_INVALID`, `ADDON_GROUP_RULE`

หน้าจอง: การ์ด "ตัวเลือกเพิ่มเติม" แยกตามกลุ่ม · กลุ่มที่เลือกได้ 1 = ปุ่มเลือก · หลายอย่าง = ช่องติ๊ก · มีจำนวน = ปุ่ม + − ·
ราคารวมในแถบล่างและการ์ดสรุปอัปเดตทันที · ตัวเลือกที่ไม่ว่างเป็นสีเทาพร้อมเหตุผล (แบบตัวเลือกอื่น)

**ที่ทำจริงต่างจากร่าง (#38):** ขั้น `addons` อยู่หลังเวลาเสมอ (ยังไม่ให้ร้านย้ายไปไว้ใน `require` เพราะต้องแก้ check ของ `booking_flows`) ·
`adds_minutes` คูณจำนวนที่เลือก · ทรัพยากรที่ตัวเลือกใช้ไม่ซ้ำกับทรัพยากรหลักของการจองเดียวกัน (สองตัวเลือกที่ใช้ทรัพยากรตัวเดียวกันในการจองเดียว = ตัวที่สองไม่ได้) ·
`price_snapshot.lines` มีเฉพาะการจองที่มีตัวเลือกเสริม (การจองเดิมหน้าตาเหมือนเดิม) · หน้า "ตัวเลือกเพิ่มเติม" บอก `maxQuantity` ที่เหลือจริง

### 11.6 หลังจอง

| ที่ไหน | ทำอะไร |
|---|---|
| แอดมิน "การจอง" | การ์ดแสดงตัวเลือกเสริมใต้ชื่อบริการ · ฟอร์มเพิ่มการจองของร้านเลือกตัวเลือกได้ (ข้ามกฎ min ได้เหมือนข้าม lead time) |
| เลื่อนนัด | ตัวเลือกเดิมตามไปด้วย · ทรัพยากรของตัวเลือกเสริมถูกเลือกใหม่ ถ้าไม่ว่างตอบ `ADDON_UNAVAILABLE` ให้ร้านตัดสินใจ |
| ลูกค้าเลื่อนเองจากลิงก์ | เหมือนข้างบน · **รุ่นแรกลูกค้าเพิ่ม/ลดตัวเลือกเองไม่ได้** (โทรหาร้าน) |
| บิล | ยอดบิลมาจาก `price_snapshot.total` เหมือนเดิม · หน้าปิดบิลแสดง `lines` |
| ความเคลื่อนไหว | ไม่เปลี่ยน (ตัวเลือกเสริมไม่ใช่เหตุการณ์แยก) |

### 11.7 การจองหลายวัน (เช่ารถ, ที่พัก, เช่าอุปกรณ์รายวัน) — ทำหลังตัวเลือกเสริม

ตอนนี้ทุกการจองอยู่ในวันเดียวและต้องจบในเวลาทำการ · โหมดใหม่:

- บริการ `duration_mode = 'days'` + `min_days`, `max_days` · ร้านตั้ง**ช่วงเวลารับ/คืน**
  (เช่น รับ 08:00–18:00, คืนภายใน 18:00) และ**เวลาผ่อนผัน** (คืนช้าไม่เกิน 1 ชม. ไม่คิดเพิ่ม)
- ขั้นในหน้าจอง: `date` (วันรับ) → `end_date` (วันคืน, ขั้นใหม่) → `time` (เวลารับ) → `return_time` (ขั้นใหม่ ถ้าร้านให้เลือก)
- การจองถือทรัพยากรต่อเนื่อง**ตลอดช่วง** (ข้ามคืน ข้ามวันหยุด) · เวลาทำการร้านใช้ตรวจแค่**ตอนรับและตอนคืน** ·
  exclusion constraint เดิมใช้ได้ (tstzrange ยาวหลายวัน)
- จำนวนวัน = ปัดขึ้น `(คืน − รับ − ผ่อนผัน) ÷ 24 ชม.` · `per_day` ทั้งบริการและตัวเลือกเสริมใช้จำนวนนี้
- ปฏิทินวันรับแสดงเฉพาะวันที่ยังมีรถว่างอย่างน้อย `min_days` วันติดกัน · ปฏิทินวันคืนแสดงถึงวันก่อนที่รถจะไม่ว่าง
- หน้าแอดมินต้องมีมุมมองแถบหลายวัน (ปฏิทินแบบ timeline ต่อรถ) — งาน UI ก้อนใหญ่ที่สุดของโหมดนี้
- มัดจำ/ชำระก่อน (คำถามข้อ 10.3) สำคัญมากกับเช่ารถ → ทำคู่กับ step 6f (ย้ายระบบชำระเงิน) จะคุ้มกว่า

### 11.8 แพ็กเกจ (ขายเป็นฟีเจอร์เสริม)

- เพิ่มฟังก์ชัน `brand_features(plan) returns text[]` คู่กับ `brand_branch_limit` (`…001100`) เช่น
  `free → {}` · `starter → {addons}` · `pro → {addons, multi_day}` (ตัวเลขจริงรอเจ้าของตัดสิน ข้อ 11.9)
- RPC ที่แก้กลุ่ม/ตัวเลือกเสริม และการตั้งบริการแบบหลายวัน ตรวจสิทธิ์ก่อน → `BK422 PLAN_REQUIRED`
- แอดมินแสดงเมนูที่ล็อก + ปุ่ม "อัปเกรด" (ยังไม่มีระบบเก็บเงินค่าแพ็กเกจ: Kiwmee ตั้งแพ็กเกจให้เองแบบตอนนี้)
- **แพ็กเกจหมดอายุ**: ตัวเลือกเสริมหายจากหน้าจองใหม่ แต่การจองที่มีอยู่และราคาใน snapshot ไม่เปลี่ยน · ข้อมูลไม่ถูกลบ ต่ออายุแล้วกลับมา

### 11.9 สิ่งที่ตัดสินแล้ว และคำถามที่เหลือ

**ตัดสินแล้ว (2 พ.ย. 2569):**
- **ธุรกิจแรก = สนามกีฬา** · ตัวเลือกเสริมที่ต้องมีในรุ่นแรก = **เช่าอุปกรณ์** (ไม้, ลูก, เสื้อเอี๊ยม)
  → ใช้ `uses_kind` + ทรัพยากรความจุ > 1 (เช่น "ไม้แบด" มี 10 อัน) ราคา `per_unit` หรือ `per_hour` · ของที่ขายขาด (ลูกแบดเปิดหลอดใหม่)
  ใช้ `per_unit` โดยไม่ผูกทรัพยากร (ร้านนับสต็อกเอง รุ่นแรกไม่ตัดสต็อก)
- **มัดจำรุ่นแรก = โอนเงิน**: ใช้ `held` + `hold_expires_at` ที่มีแล้ว · ลูกค้าแนบสลิปจากหน้าจอง/ลิงก์จัดการการจอง ·
  ร้านกดยืนยันในแอดมิน (`confirm_booking`) แล้วบันทึกเป็น `bill_payments.kind = 'deposit'` · ไม่ตรวจสลิปอัตโนมัติในรุ่นแรก
  (ตอบคำถามข้อ 10.3 บางส่วน — ยังต้องตั้งว่า "มัดจำต่อบริการหรือต่อร้าน" และ "ปล่อยคิวอัตโนมัติเมื่อหมดเวลาไหม" ตอนทำ)
- **ของที่ลูกค้านำออกไปใช้** (รถ กล้อง มือถือ) = โหมดหลายวัน ข้อ 11.7 **ทำทีหลัง** พร้อม
  การแนบเอกสาร (บัตรประชาชน/ใบขับขี่ → ต้องมีนโยบาย PDPA, เก็บแบบเข้ารหัส, ลบตามกำหนด) และผูกกับสมาชิก LINE + คะแนนสะสม (`docs/LOYALTY_DESIGN.md`)

**ยังรอตอบ** (ใช้ข้อแนะนำเป็นค่าเริ่มต้นถ้าเจ้าของไม่เปลี่ยน):

1. **แพ็กเกจไหนได้ตัวเลือกเสริม**: แนะนำ starter ขึ้นไป (ฟรีไม่มี) · โหมดหลายวัน pro ขึ้นไป · หรือขายแยกเป็นรายฟีเจอร์?
2. **ลูกค้าเพิ่ม/ลดตัวเลือกเองจากลิงก์จัดการการจอง**ได้ไหม (แนะนำ: รุ่นแรกไม่ได้)
3. **`adds_minutes`** ต้องมีในรุ่นแรกไหม (แนะนำ: มี เพราะร้านเสริมสวยใช้บ่อย และกระทบการคำนวณเวลา ทำทีเดียวคุ้มกว่า)
4. ~~ธุรกิจหลายวันรายแรก~~ → ตอบแล้วข้างบน (สนามกีฬาก่อน · ของนำออกไปใช้ทีหลังพร้อมเอกสาร)
5. ของที่ขายโดยไม่ผูกเวลา (แชมพู 1 ขวด) **ไม่ใช่**ตัวเลือกเสริม — ใช้ "ขายหน้าร้าน" ในบิลเหมือนเดิม ตกลงตามนี้ไหม

### 11.10 ลำดับการทำ

ลำดับตามธุรกิจแรก (สนามกีฬา): A → B → C ใช้กับสนามได้ครบ · มัดจำโอนเงิน (M) ทำต่อจาก C หรือคู่กับ Phase 1 LINE ·
D ทำเมื่อเริ่มเก็บเงินค่าแพ็กเกจ · E หลังมีลูกค้าเช่าของจริง

| PR | งาน | เสร็จเมื่อ |
|---|---|---|
| A ✅ (#37) | migration `…002000`: 4 ตาราง + `booking_resources.addon_id` + RLS · แอดมินตั้งกลุ่ม/ตัวเลือกในแท็บ "บริการและราคา" (`saveAddonGroup`, `/api/dashboard/shops/<slug>/addon-groups`) · ยังไม่แสดงในหน้าจอง · `add_branch` ยังไม่คัดลอกตัวเลือกเสริมไปสาขาใหม่ (ทำใน B) | DB test: anon อ่านไม่ได้, ร้าน A แตะร้าน B ไม่ได้, staff แก้ไม่ได้, FK ข้ามร้านไม่ได้, กฎ min/max |
| B ✅ (#38) | เครื่องคำนวณ (`ask: "addons"`, `adds_minutes`, ทรัพยากรเสริม, reconcile) + `create_booking` + ราคา `lines` · migration `…002100` | unit test ทุกชนิด · DB test: คนขับ 1 คน 2 การจองพร้อมกัน → คนที่ 2 ได้ `ADDON_UNAVAILABLE` · คาร์ซีท 3 ตัวรับคนที่ขอตัวที่ 4 ไม่ได้ · ราคาทุก unit |
| C ✅ (#38) ยกเว้นฟอร์มร้าน | หน้าจองขั้น "ตัวเลือกเพิ่มเติม" + แอดมิน (การ์ด ✅, ฟอร์มเพิ่มการจอง ❌ ยังไม่ทำ, เลื่อนนัด ✅, ยอดบิลรวมตัวเลือก ✅) | Playwright: จองสนาม + เช่าไม้ 2 · จองทัวร์ + คนขับ |
| D | `brand_features` + ล็อกเมนูตามแพ็กเกจ | DB test: แพ็กเกจฟรีสร้างตัวเลือกไม่ได้ · หมดอายุแล้วการจองเดิมไม่เปลี่ยน |
| M ✅ (#39) | มัดจำโอนเงิน: ตั้งยอดมัดจำต่อร้าน (คงที่/เปอร์เซ็นต์/เต็มจำนวน) + บัญชี · การจองเป็น `held` จน `hold_minutes` · ลูกค้าแนบสลิป → `pending` (ไม่หมดเวลาแล้ว) · ร้านดูสลิป + "ยืนยันมัดจำ" → `confirmed` + `bill_payments` deposit · ปฏิเสธ = ยกเลิกการจอง · สลิปเก็บใน `payment_slips` (WebP ≤ 1.5 MB, สมาชิกร้านอ่านได้เท่านั้น) · migration `…002200` | DB test: hold หมดเวลาปล่อยคิว · ยืนยันแล้วยอดมัดจำหักในบิล · สลิปเห็นเฉพาะร้านนั้น |
| E | (ภายหลัง) โหมดหลายวัน ข้อ 11.7 + เอกสารประกอบการเช่า + ผูกสมาชิก/คะแนน | แยกแบบละเอียดอีกครั้งก่อนทำ |
