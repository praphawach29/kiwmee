# คะแนนสะสม + บัญชีลูกค้าผ่าน LINE — Design

สถานะ: **ออกแบบ ยังไม่เริ่มทำ** · 28 ต.ค. 2569 (ปรับ: ได้คะแนนตอนปิดบิล · บิลแยกจากการจอง · LINE OA กลาง · แพ็กเกจ · ระดับสมาชิกและบัตร · ราคา LINE ปี 2567) · ต่อจาก `docs/FLEXIBLE_BOOKING_DESIGN.md` (ขั้นที่ 1–5 เสร็จแล้ว)

**ตัดสินใจแล้ว** (27 ต.ค. 2569):

1. คะแนน**ใช้ได้ทุกสาขาของแบรนด์เดียวกัน** (เช่น ร้านก๋วยเตี๋ยว 5 สาขา) และแบรนด์จำกัดให้ได้/ใช้คะแนนเฉพาะบางสาขาได้
2. **ร้านออกแบบกติกาเอง**: ได้คะแนนเท่าไหร่ต่อยอดใช้จ่าย และแลกอะไรได้ (ใช้ฟรี 1 ครั้ง หรือเป็นส่วนลด)
3. ลูกค้า**เลือกใช้คะแนนตอนชำระเงิน**
4. คะแนน**มีวันหมดอายุ** ร้านกำหนดเอง
5. ยืนยันตัวตนลูกค้าด้วย **LINE อย่างเดียว** (ไม่ทำ OTP เบอร์โทร) · ใช้ LINE ส่งการ์ดยืนยัน/เตือนนัดไปด้วย
6. **ได้คะแนนตอนปิดบิล (ชำระเงินสำเร็จ)** จากยอดที่จ่ายจริง แบบเดียวกับระบบจองทั่วไป (ข้อ 4) · มัดจำ ยกเลิก ไม่มา ไม่ได้คะแนน ·
   คืนเงินแล้วดึงคะแนนคืนตามสัดส่วน · เตือนก่อนคะแนนหมดอายุทาง LINE · เศษคะแนน**ปัดทิ้ง** (150 บาท ทุก 100 ได้ 10 → 10)
7. **บิลแยกจากการจอง** (28 ต.ค.): ร้านที่ไม่รับจอง (เช่น ร้านก๋วยเตี๋ยว) ใช้ระบบสมาชิกได้ด้วย — สแกน QR สมาชิก ใส่ยอด ได้คะแนน
8. **เริ่มด้วย LINE OA กลางของ Kiwmee** (28 ต.ค.): การ์ดทุกร้านส่งจาก OA เดียว · ให้ร้านใช้ OA ของตัวเองเป็นตัวเลือกภายหลัง
9. **ผลิตภัณฑ์เดียว แบ่งตามแพ็กเกจ** (28 ต.ค.): ระบบจองมีแบบฟรีจำกัดจำนวน/ราคาถูก · ระบบสมาชิกเป็นแพ็กเกจโปร (ข้อ 8)

ตัวอย่างที่ต้องทำได้:

- สนามกีฬา: จ่ายทุก 100 บาท ได้ 10 คะแนน · 100 คะแนน = ใช้สนามฟรี 1 ชั่วโมง **หรือ** ส่วนลด 100 บาท
- ร้านตัดผม 3 สาขา: มาครบ 10 ครั้งตัดฟรี 1 ครั้ง ใช้ได้ทุกสาขา แต่บริการทำสีแลกได้เฉพาะสาขาใหญ่
- คะแนนหมดอายุ 12 เดือนหลังได้รับ

---

## 1. ลูกค้าคือใคร: บัญชี LINE

| ตอนนี้ | หลังทำ |
|---|---|
| `customers` แยกต่อร้าน · จับคู่ด้วยเบอร์โทร (ไม่ได้ยืนยัน) | ยังเก็บไว้ (ลูกค้า walk-in, ร้านบันทึกเอง) |
| `customers.line_user_id` มีแล้ว แต่ใช้แค่ตอนจองผ่าน LIFF | **คนเดียวกันข้ามร้าน = `line_user_id` เดียวกัน** → ใช้เป็นตัวตนของประวัติและคะแนน |

- LIFF ตัวเดียวของแพลตฟอร์ม (Kiwmee) ใช้ได้ทุกร้าน เพราะ URL มี slug · ทุก channel ของ Kiwmee ต้องอยู่ใต้ **LINE provider เดียวกัน**
  เพราะ LINE ให้ `userId` คนละค่าในแต่ละ provider (ถ้าภายหลังร้านใช้ LINE OA ของตัวเองคนละ provider ต้องผูกบัญชีเพิ่ม — ยังไม่ทำ)
- เซิร์ฟเวอร์ตรวจ ID token กับ LINE ทุกครั้ง (`verifyLineIdToken` มีแล้วใน `src/v2/public-booking.js`) ไม่เชื่อ `userId` ที่หน้าเว็บส่งมาเอง
- **ได้คะแนนเฉพาะบิลที่ผูก LINE** · การจองผ่าน LIFF ผูกให้เอง · ลูกค้าที่จองทางเว็บ, walk-in หรือร้านที่ไม่รับจอง ผูกด้วย QR สมาชิกตอนปิดบิล (ข้อ 5)
- **LINE OA กลางของ Kiwmee** ส่งการ์ดยืนยัน/เตือนนัด/เตือนคะแนนหมดอายุของทุกร้าน (Kiwmee จ่ายค่าข้อความ คิดรวมในราคาแพ็กเกจ) ·
  การ์ดแสดงชื่อและโลโก้ร้านเป็นหลัก · ภายหลัง: ร้านในแพ็กเกจโปรเชื่อม OA ของตัวเอง (ต้องแก้เรื่อง `userId` คนละ provider ก่อน)

### หน้า "ของฉัน" ใน LIFF (`/me`)

- นัดที่จะถึง (ทุกร้าน) พร้อมปุ่มเลื่อน/ยกเลิก (ใช้กติกาและ RPC ที่ทำแล้ว `customer_*_booking`)
- ประวัติการใช้บริการ (สถานะ `completed`) แยกตามร้าน/แบรนด์
- คะแนนคงเหลือต่อแบรนด์ · คะแนนที่จะหมดอายุเร็ว ๆ นี้ · รายการได้/ใช้คะแนน
- QR สมาชิก ให้ร้านสแกนตอน walk-in

---

## 2. แบรนด์และสาขา (ตอบคำถามข้อ 2 "หลายสาขา" ใน design หลัก)

แต่ละสาขายังเป็น 1 แถวใน `businesses` เหมือนเดิม (เวลาทำการ ช่าง คิว แยกกัน) แล้วเพิ่มชั้น **แบรนด์** ครอบไว้

```sql
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
alter table public.businesses add column brand_id uuid references public.brands(id);
-- ร้านเดิมทุกร้านได้แบรนด์ของตัวเอง 1 แบรนด์ (1 สาขา) ตอน migrate
create table public.brand_members (            -- เจ้าของแบรนด์: ตั้งกติกาคะแนน ดูทุกสาขา
  brand_id uuid references public.brands(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text check (role in ('owner')),
  primary key (brand_id, user_id)
);
```

- ร้านเปิดใหม่ = แบรนด์ใหม่ 1 สาขา · หน้าแอดมินมีปุ่ม "เพิ่มสาขา" (สร้าง `businesses` ใหม่ในแบรนด์เดิม คัดลอกบริการ/ราคา/flow มาให้)
- RLS: ข้อมูลคะแนนอ่านได้โดยสมาชิกของสาขาใดก็ได้ในแบรนด์ · แก้กติกาได้เฉพาะเจ้าของแบรนด์

---

## 3. กติกาคะแนนที่ร้านตั้งเอง

```sql
create table public.loyalty_programs (         -- 1 แบรนด์ 1 โปรแกรม
  brand_id uuid primary key references public.brands(id) on delete cascade,
  active boolean not null default false,
  name text not null default 'คะแนนสะสม',
  -- ได้คะแนน: แบบยอดเงิน (ทุก earn_per_baht บาท ได้ earn_points คะแนน) หรือแบบครั้ง (มา 1 ครั้ง ได้ earn_points)
  earn_mode text not null default 'per_baht' check (earn_mode in ('per_baht','per_visit')),
  earn_per_baht numeric check (earn_per_baht > 0),          -- 100
  earn_points int not null check (earn_points > 0),          -- 10
  expire_months int check (expire_months > 0),               -- null = ไม่หมดอายุ
  updated_at timestamptz not null default now()
);

create table public.loyalty_branch_rules (     -- ไม่มีแถว = สาขานั้นได้และใช้คะแนนได้ตามปกติ
  brand_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  can_earn boolean not null default true,
  can_redeem boolean not null default true,
  primary key (brand_id, business_id)
);

create table public.loyalty_rewards (          -- ของที่แลกได้ ร้านเพิ่มเองได้หลายรายการ
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,                           -- "ใช้สนามฟรี 1 ชม.", "ส่วนลด 100 บาท"
  kind text not null check (kind in ('discount','free_offering')),
  points_cost int not null check (points_cost > 0),          -- 100
  discount_baht numeric check (discount_baht > 0),           -- kind = discount
  offering_ids uuid[],                          -- kind = free_offering: บริการที่ฟรีได้ (ข้ามสาขาได้)
  max_free_minutes int,                         -- free_offering แบบรายชั่วโมง: ฟรีสูงสุดกี่นาที (สนาม 60)
  business_ids uuid[],                          -- null = ทุกสาขาที่ can_redeem · มีค่า = เฉพาะสาขาเหล่านี้
  image_path text,                              -- รูปปกรางวัล (Supabase Storage) แสดงเป็นการ์ดคูปอง
  description text,
  stock int check (stock >= 0),                 -- จำนวนสิทธิ์ทั้งหมด ("จำนวน 1,000 สิทธิ์") · null = ไม่จำกัด
  per_member_limit int check (per_member_limit > 0),   -- แลกได้กี่ครั้งต่อคน · null = ไม่จำกัด
  starts_at timestamptz, ends_at timestamptz,   -- ช่วงแคมเปญ ("1 แถม 1" ถึงสิ้นเดือน)
  active boolean not null default true
);
```

- **คิดคะแนนจากยอดที่จ่ายจริง** (หลังหักส่วนลดจากคะแนน) ปัดลง: 250 บาท, ทุก 100 ได้ 10 → 20 คะแนน
- `per_visit` = บัตรสะสมตรา: มาครบ 10 ครั้ง (`earn_points` 1, รางวัล `points_cost` 10)
- เปลี่ยนกติกาแล้ว**ไม่คิดย้อนหลัง** คะแนนที่ได้ไปแล้วคงเดิม
- รางวัลแสดงเป็น**การ์ดคูปองมีรูป** (แบบ Privage): ชื่อ, จำนวนสิทธิ์ที่เหลือ, ใช้กี่คะแนน, ป้าย "แลกได้" / "คะแนนไม่พอ" / "หมดแล้ว" ·
  สิทธิ์ที่เหลือนับจากรายการ redeem + hold (ล็อกต่อรางวัล กันแลกเกินจำนวน)

---

## 3.1 ระดับสมาชิก และบัตรสมาชิก

ลูกค้าเห็น**บัตรสมาชิกของแต่ละแบรนด์**ในหน้า "ของฉัน" และ Rich menu ของ LINE · สีและหน้าตาบัตรเปลี่ยนตามระดับ

```sql
create table public.loyalty_tiers (            -- ไม่มีแถว = ไม่มีระดับ (ทุกคนบัตรเดียวกัน)
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,                           -- "Member", "Silver", "Gold", "Platinum"
  rank int not null,                            -- 0 = ระดับเริ่มต้น
  -- ขึ้นระดับเมื่อยอดใช้จ่าย (หรือจำนวนครั้ง) ในช่วง qualify_months เดือนล่าสุดถึงเกณฑ์
  min_spend numeric not null default 0,
  min_visits int not null default 0,
  earn_multiplier numeric not null default 1 check (earn_multiplier >= 1),   -- Gold ได้คะแนน x1.5
  card_style jsonb not null default '{}',       -- { theme: "gold", from: "#C9A24B", to: "#8C6A1F", text: "#FFF", pattern: "wave" }
  benefits text[],                              -- ข้อความสิทธิพิเศษที่แสดงบนบัตร
  unique (brand_id, rank)
);
alter table public.loyalty_programs add column qualify_months int not null default 12;
alter table public.loyalty_rewards add column min_tier_rank int not null default 0;  -- รางวัลเฉพาะระดับ
```

**ระดับคำนวณจากบิล** (ยอด `total` ของบิลที่ปิดแล้ว หักที่คืนเงิน ใน `qualify_months` เดือนล่าสุด) ไม่ได้มาจากคะแนน
→ ใช้คะแนนแลกของแล้ว**ระดับไม่ตก** (แบบที่ Privage และ MyCustomer ทำ) · คำนวณใหม่ตอนปิดบิล/คืนเงิน และงานรายวัน (ตกระดับเมื่อยอดย้อนหลังไม่ถึง)
· ขึ้นระดับแล้วส่งการ์ด LINE แสดงบัตรใหม่ · เจ้าของแบรนด์ตั้งระดับได้ไม่เกิน 5 ระดับ

**บัตรสมาชิก** (หน้า "ของฉัน", เปิดจาก Rich menu ได้ทันที):

```
┌──────────────────────────────────────┐
│ [โลโก้แบรนด์]               GOLD ✦   │  ← สี/ลายตาม card_style ของระดับ
│                                      │
│ คุณสมใจ ใจดี · เลขสมาชิก K-000123     │
│ 1,250 คะแนน · หมดอายุ 120 คะแนน 31 ธ.ค.│
│ ▓▓▓▓▓▓▓░░░ อีก 2,300 บาท ถึง Platinum │  ← แถบความคืบหน้าไประดับถัดไป
│                         [QR สมาชิก]  │  ← ร้านสแกนตอนปิดบิล (QR เปลี่ยนทุก 60 วินาที)
└──────────────────────────────────────┘
```

- มีแม่แบบสำเร็จรูป (Classic, Silver, Gold, Platinum, Black) ให้เลือก + ร้านใส่โลโก้และสีแบรนด์เอง · พรีวิวในหน้าแอดมินแบบเดียวกับพรีวิวหน้าจอง
- ลูกค้าที่มีหลายแบรนด์ปัดดูบัตรทีละใบ (แบบ Wallet) · บัตรกดเพิ่มลง Rich menu / แชร์ให้เพื่อนสมัครได้ (ภายหลัง)
- QR สมาชิกเป็นรหัสชั่วคราวที่เซิร์ฟเวอร์ออกให้ (หมดอายุ 60 วินาที) ไม่ใช่ `line_user_id` ตรง ๆ กันคนแคปหน้าจอไปใช้
- ระดับสมาชิกอยู่ในแพ็กเกจโปร/สมาชิก (ข้อ 8)

## 4. สมุดบัญชีคะแนน (ledger)

คะแนนคงเหลือ**ไม่เก็บเป็นตัวเลขตัวเดียว** แต่รวมจากรายการทั้งหมด ตรวจย้อนได้ทุกแต้มว่ามาจากไหน ไปไหน

```sql
create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  line_user_id text not null,
  business_id uuid not null,                    -- สาขาที่เกิดรายการ
  bill_id uuid references public.bills(id),    -- บิลที่ได้/ใช้คะแนน (มีหรือไม่มีการจองก็ได้)
  booking_id uuid references public.bookings(id),   -- hold ตอนจอง (ยังไม่มีบิล)
  kind text not null check (kind in ('earn','hold','redeem','release','reverse','expire','adjust')),
  points int not null,                          -- + ได้ / − ใช้
  earned_lot uuid references public.loyalty_ledger(id),   -- รายการ "ใช้/หมดอายุ" ตัดจากล็อตไหน (FIFO)
  expires_at timestamptz,                       -- เฉพาะ earn
  reward_id uuid references public.loyalty_rewards(id),
  created_by uuid,                              -- พนักงานที่กด (adjust) หรือ null = ระบบ
  note text,
  created_at timestamptz not null default now()
);
-- เขียนผ่าน RPC เท่านั้น ห้าม update/delete (append-only) · ล็อกต่อ (brand, line_user_id) ตอนใช้คะแนน กันกดใช้ซ้อน
```

**ได้คะแนน** — ตอน**ปิดบิล** (ข้อ 5 `close_bill`) ไม่ใช่ตอนกดสถานะ:
บิลผูก `line_user_id` + โปรแกรมเปิด + สาขา `can_earn` → เขียน `earn` จาก**ยอดที่จ่ายจริงหลังหักส่วนลดจากคะแนน** (รวมมัดจำที่จ่ายไว้แล้ว)
ปัดเศษทิ้ง พร้อม `expires_at = now() + expire_months` · บิลปิดได้ครั้งเดียว และ 1 การจองมีบิลได้ใบเดียว จึงได้คะแนนครั้งเดียว

**ไม่ได้คะแนน** — มัดจำ (นับรวมตอนปิดบิล ไม่ได้แยก) · ยกเลิก · ไม่มา (รวมค่าปรับ) · จ่ายเต็มออนไลน์ล่วงหน้าได้คะแนนตอนมาใช้บริการแล้ว
ไม่ใช่ตอนโอน (ไม่ต้องตามดึงคืนถ้าไม่มา/ขอคืนเงิน)

**คืนเงิน** — คืนเต็ม: `reverse` คะแนนของบิลนั้นทั้งหมด · คืนบางส่วน: `reverse` ตามสัดส่วนยอดที่คืน ปัดลง ·
รางวัลที่แลกไปแล้ว**ไม่คืนอัตโนมัติ** (ร้านคืนเองด้วย `adjust` ถ้าต้องการ) · ถ้าคะแนนที่ต้องดึงคืนถูกใช้ไปแล้ว ยอดคงเหลือติดลบได้
และคะแนนที่ได้ครั้งต่อไปหักส่วนที่ติดลบก่อน

**หมดอายุ** — ใช้คะแนนจากล็อตที่หมดอายุก่อนเสมอ (FIFO) · งานรายวัน (pg_cron) เขียน `expire` ให้ล็อตที่หมดอายุแล้วยังเหลือแต้ม ·
**ส่งการ์ด LINE เตือน 14 วันก่อนหมดอายุ** · หน้า "ของฉัน" แสดง "xx คะแนนจะหมดอายุ dd/mm" ·
ร้านแก้วันหมดอายุภายหลัง: มีผลกับคะแนนที่ได้หลังจากนั้นเท่านั้น (ล็อตเดิมคง `expires_at` เดิม)

---

## 5. บิล (รับชำระ) และใช้คะแนน

ระบบจองทั่วไป (Fresha, Square, Booksy, Vagaro) ให้คะแนนและใช้รางวัล**ตอน checkout** ซึ่งสำหรับร้านบริการคือตอนใช้บริการเสร็จแล้วจ่ายเงิน
Kiwmee จึงมี **"บิล"** เป็นของแยกจากการจอง: บิลผูกการจองได้ (ร้านที่รับจอง) หรือไม่ผูกก็ได้ (walk-in, ร้านที่ไม่รับจองเลย)

```sql
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id),
  booking_id uuid,                              -- null = ขายหน้าร้าน ไม่มีการจอง
  customer_id uuid,                             -- ลูกค้าของร้าน (ถ้ารู้)
  line_user_id text,                            -- ผูกสมาชิก (จอง LIFF / สแกน QR) → ได้คะแนน
  status text not null default 'open' check (status in ('open','closed','void')),
  subtotal numeric not null default 0,          -- ราคาก่อนส่วนลด (จากการจอง = price_snapshot, ขายหน้าร้าน = พนักงานใส่)
  discount numeric not null default 0,          -- ส่วนลดจากรางวัล
  total numeric generated always as (greatest(subtotal - discount, 0)) stored,
  reward_id uuid,                               -- 1 บิลใช้ได้ 1 รางวัล
  note text,
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (booking_id, business_id) references public.bookings(id, business_id)
);
create unique index bills_one_per_booking on public.bills(booking_id) where booking_id is not null and status <> 'void';

create table public.bill_payments (            -- มัดจำ, ยอดที่รับ, คืนเงิน
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bill_id uuid not null,
  kind text not null check (kind in ('deposit','payment','refund')),
  method text not null check (method in ('cash','transfer','card','online')),
  amount numeric not null check (amount > 0),   -- refund ก็เป็นบวก
  recorded_by uuid,                             -- พนักงาน หรือ null = ระบบชำระเงินออนไลน์
  created_at timestamptz not null default now(),
  foreign key (bill_id, business_id) references public.bills(id, business_id)
);
```

**`close_bill(bill, reward?, payments[])`** — RPC เดียว ทำทุกอย่างใน transaction เดียว:

```
subtotal − ส่วนลดจากรางวัล = total
  − มัดจำที่จ่ายไว้แล้ว = ยอดที่พนักงานรับเพิ่ม (เงินสด / โอน / บัตร) · ยอดรับต้องครบ total
  → บันทึก bill_payments · status = closed · การจองที่ผูกไว้ (ถ้ามี) = completed
  → redeem รางวัล (ตัดคะแนนจริง) · earn คะแนนจาก total
```

- **ร้านที่รับจอง**: ปุ่ม "ปิดบิล" ในรายการจอง เปิดบิลจากการจองให้เอง (subtotal = ราคาของการจอง แก้ได้ เช่น ลูกค้าเพิ่มบริการ)
- **ขายหน้าร้าน / ร้านที่ไม่รับจอง**: หน้า "เปิดบิล" ใส่ยอด (หรือเลือกบริการ) → สแกน QR สมาชิก → ปิดบิล
- หน้าปิดบิลแสดงคะแนนคงเหลือและรางวัลที่ใช้ได้ที่สาขานี้ให้พนักงานเลือก (แบบ Fresha) · ลูกค้าเลือกไว้ล่วงหน้าได้ (ด้านล่าง)
- ร้านที่ยังไม่อยากบันทึกเงิน กด "เสร็จแล้ว" ได้เหมือนเดิม แต่**ไม่ได้คะแนน** จนกว่าจะปิดบิล
- ปิดบิลแล้วแก้ยอดไม่ได้ ใช้ "คืนเงิน" (`refund_bill`, ข้อ 4) · บิลที่ยังไม่ปิดยกเลิกได้ (`void`) ·
  "ย้อนกลับ" จาก completed ทำได้เฉพาะการจองที่ยังไม่ปิดบิล
- เจ้าของร้านดู "รายรับวันนี้" จาก `bill_payments` (ยอดที่รับจริง แยกเงินสด/โอน/บัตร) · พนักงานปิดบิลได้ แต่คืนเงินได้เฉพาะเจ้าของ

**ลูกค้าเลือกใช้คะแนนตอนจอง** (ขั้น `payment` ของ flow):

```
เลือกบริการ/เวลา → ขั้นชำระเงิน: "ใช้ 100 คะแนน แลก ส่วนลด 100 บาท" ☐ → ยืนยัน
  1. hold:    กันคะแนนไว้กับการจอง (ยังไม่ตัดจริง) · หน้าจองแสดงยอดหลังหักส่วนลด
  2. redeem:  ตอนปิดบิล → คะแนนที่กันไว้ถูกใช้จริง (พนักงานเปลี่ยนรางวัลได้ตอนปิดบิล)
  3. release: ยกเลิก / ไม่มา / hold หมดเวลา → คืนคะแนนที่กันไว้
```

- จ่ายออนไลน์ (ขั้น 6f): ยอดที่ต้องโอน = ยอดหลังหักส่วนลด · เปิดบิลตอนจอง แล้วระบบชำระเงินบันทึกเป็น `bill_payments` (`deposit` หรือ `online`)
- ฐานข้อมูลตรวจซ้ำตอน hold และตอนปิดบิล: คะแนนพอ · รางวัลใช้ได้ที่สาขานี้ · ใช้กับบริการนี้ได้ (free_offering) · 1 บิลใช้ได้ 1 รางวัล

---

## 6. ลำดับการทำ

| ขั้น | งาน | ต้องมีก่อน |
|---|---|---|
| 6a | LIFF: ล็อกอิน LINE ในหน้าจอง · การ์ดยืนยันการจอง · การ์ดเตือนก่อนนัด (ปุ่มเลื่อน/ยกเลิกเปิดหน้าที่ทำแล้ว) | **LINE Login channel + LIFF app + Messaging API channel** (ผู้ใช้สร้าง) |
| 6b | หน้า "ของฉัน" (`/me`): นัดที่จะถึง + ประวัติ ข้ามร้าน | 6a |
| 6c | แบรนด์/สาขา: ตาราง `brands`, ย้ายร้านเดิม, ปุ่มเพิ่มสาขา, เจ้าของแบรนด์ | — (ทำคู่กับ 6a ได้) |
| 6d | **บิล**: ปิดบิลจากการจอง + เปิดบิลขายหน้าร้าน (`bills`, `bill_payments`, `close_bill`, `refund_bill`) · รายรับวันนี้ | — (ทำได้เลย ไม่ต้องรอ LINE) |
| 6e | ตั้งกติกาคะแนน (หน้าแอดมิน) · ได้คะแนนตอนปิดบิล · ดึงคืนตอนคืนเงิน · หมดอายุ + การ์ดเตือน 14 วัน · แสดงใน `/me` · QR สมาชิก | 6b, 6c, 6d |
| 6e+ | ระดับสมาชิก + บัตรสมาชิกตามระดับ (แม่แบบ, พรีวิว, การ์ดขึ้นระดับ) | 6e |
| 6f | ขั้น `payment` ในหน้าจอง: ลูกค้าเลือกรางวัล, hold/redeem/release · ย้ายระบบชำระเงิน/ตรวจสลิปของ v1 มาใช้กับ v2 | 6e |

ทดสอบที่ต้องมี (ตามกติกาเดิม: anon อ่านไม่ได้, ข้ามแบรนด์ไม่ได้): กดใช้คะแนนพร้อมกัน 2 เครื่องตัดได้ครั้งเดียว ·
ปิดบิลซ้ำได้คะแนนครั้งเดียว · มัดจำ/ยกเลิก/ไม่มาไม่ได้คะแนน · คืนเงินบางส่วนดึงคะแนนคืนตามสัดส่วน ·
ล็อตเก่าหมดอายุก่อน · สาขาที่ปิด can_redeem แลกไม่ได้ · ID token ปลอมเข้า `/me` ไม่ได้

---

## 7. คำถามที่ยังต้องตอบ

1. ~~ไม่มาตามนัด~~ → ไม่ได้คะแนน และคะแนนที่กันไว้คืนให้ลูกค้า (เหมือนยกเลิก)
2. ~~ใช้หลายรางวัลในการจองเดียว~~ → **ทีละ 1 รางวัลต่อการจอง** (เช่น ครบ 10 ครั้ง ฟรี 1 ครั้ง) · คะแนนที่เหลือเก็บไว้ต่อ (110 ใช้ 100 เหลือ 10)
3. ~~คะแนนเศษจากยอดเงิน~~ → **ปัดทิ้ง** (150 บาท ทุก 100 ได้ 10 → 10)
4. ~~ร้านแจกคะแนนเอง~~ → **เจ้าของแบรนด์** เท่านั้น ทั้งแจก/ปรับคะแนน (`adjust`) และตั้งรางวัล ·
   รางวัลแต่ละรายการเลือกได้ว่าใช้ได้ทุกสาขา หรือเฉพาะสาขาที่กำหนด (`loyalty_rewards.business_ids`)
5. ~~ค่าบริการ~~ → ระบบคะแนนเป็น**แพ็กเกจเสียเงิน** (แพ็กเกจโปร) · ระบบจองมีแบบฟรีจำกัดจำนวน/แพ็กเกจราคาถูก

---

## 8. แพ็กเกจ (ร่าง ตัวเลขยังไม่ได้ตั้ง)

ผลิตภัณฑ์เดียว โค้ดและฐานข้อมูลชุดเดียว เปิด/ปิดฟีเจอร์ตามแพ็กเกจของ**แบรนด์** · ฐานข้อมูลตรวจสิทธิ์เอง (RPC ของฟีเจอร์โปรปฏิเสธถ้าแพ็กเกจไม่ถึง)

| | ฟรี | เริ่มต้น | โปร | สมาชิกอย่างเดียว |
|---|---|---|---|---|
| การจองออนไลน์ | จำกัด เช่น 50/เดือน | ไม่จำกัด | ไม่จำกัด | — |
| การ์ด LINE ยืนยัน / เตือนนัด | ยืนยันอย่างเดียว | ✓ | ✓ | — |
| บิล / รายรับ | ✓ | ✓ | ✓ | ✓ |
| สาขาในแบรนด์ | 1 | 1 | หลายสาขา | หลายสาขา |
| คะแนนสะสม + รางวัล + QR สมาชิก + เตือนหมดอายุ | — | — | ✓ | ✓ |
| ระดับสมาชิก + บัตรสมาชิกตามระดับ | — | — | ✓ | ✓ |
| ส่งการ์ดในนาม LINE OA ของร้านเอง | — | — | ภายหลัง | ภายหลัง |

ต้นทุนข้อความ LINE (OA กลาง) ตามที่ LINE ประกาศ มีผล 1 ส.ค. 2567 (ราคายังไม่รวม VAT):

| แพ็กเกจ LINE OA | ราคา/เดือน | ข้อความในแพ็กเกจ | ข้อความส่วนเกิน* |
|---|---|---|---|
| Free | 0 | 300 | ส่งเกินไม่ได้ |
| Basic | 1,280 บาท | 15,000 | ~0.10 บาท |
| Pro | 1,780 บาท | 35,000 | ~0.06 บาท |

\* ค่าส่วนเกินมาจากบทความภายนอก ยังไม่ได้ยืนยันกับ LINE · นับต่อผู้รับ 1 คน · 1 การจอง ≈ 2 ข้อความ (ยืนยัน + เตือน)
→ OA กลางเริ่มที่ Basic/Pro แล้วคิดเฉลี่ยราว 0.05–0.10 บาท/ข้อความ ในราคาแพ็กเกจ · แพ็กเกจฟรีของ Kiwmee ควรจำกัดการ์ดที่ส่ง

**คู่แข่งเรื่องระบบสมาชิก** (ต.ค. 2569):
- **LINE MyCustomer | CRM**: ระบบสมาชิก + สะสมแต้ม + ระดับสมาชิกของ LINE เอง **ฟรีในแพ็กเกจ Pro (1,780 บาท)** ตั้งแต่ ส.ค. 2567
  (เดิม 369 บาท/เดือน) → ร้านที่จ่าย LINE Pro อยู่แล้วได้ระบบสะสมแต้มพื้นฐานฟรี
- **Privage**: บัตรสมาชิกหลายระดับบน LINE OA (Rich menu ช่องเดียว), อัตราแต้มต่างกันตามระดับบัตร, แต้มขั้นบันได, แต้มหมดอายุ ·
  คิดค่าแพ็กเกจรายปี + เครดิต SMS OTP · ระบบสำหรับองค์กรใหญ่เริ่มที่ 300,000 บาท
- จุดต่างของ Kiwmee: **จองคิว + บิล + สมาชิก ในที่เดียว**, คะแนนข้ามสาขา, ไม่ต้องใช้ OTP (ใช้ LINE), ร้านเล็กเริ่มได้ไม่ต้องมี LINE OA ของตัวเอง

```sql
create table public.brand_plans (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','starter','pro','loyalty')),
  valid_until timestamptz,                      -- หมดแล้วกลับเป็น free (ข้อมูลไม่หาย)
  updated_at timestamptz not null default now()
);
-- เก็บเงินค่าแพ็กเกจจากร้าน: งานแยก ภายหลัง (ระหว่างนี้ Kiwmee ตั้งแพ็กเกจให้เองใน SQL)
```

---

## 9. ระบบอื่นทำกันอย่างไร (อ้างอิง 27 ต.ค. 2569)

| เรื่อง | ระบบจองทั่วไป | Kiwmee |
|---|---|---|
| ได้คะแนนเมื่อไหร่ | Fresha: ต่อนัดที่เสร็จ คิดจากยอดในบิลตอน checkout · Square: ตอนซื้อ/ชำระ · Booksy: ปั๊มบัตรเมื่อมาใช้บริการ | ตอนปิดบิล |
| มัดจำ / ยกเลิก / ไม่มา | Fresha: ยกเลิกและไม่มา (รวมค่าปรับ) ไม่นับ · Booksy: มัดจำหักจากยอดตอน checkout | เหมือนกัน |
| คืนเงิน | Square: คืนเต็มดึงคะแนนทั้งหมด คืนบางส่วนดึงตามสัดส่วน ปัดลง · ไม่คืนรางวัลที่แลกแล้ว | เหมือนกัน |
| ใช้รางวัล | Fresha, Vagaro: แสดงและใช้ในหน้า checkout | หน้าปิดบิล + ลูกค้าเลือกล่วงหน้าตอนจอง |
| หมดอายุ | Square: ตั้งเป็นเดือน หรือไม่หมดอายุ · SMS เตือน 14 วันก่อน · แก้กติกาภายหลังมีผลกับคะแนนใหม่ | เหมือนกัน เตือนทาง LINE |
| หลายสาขา | Square: เลือกสาขาที่ร่วมโปรแกรม | แบรนด์ + `loyalty_branch_rules` |

ที่มา: Fresha Help Center (Client loyalty points, Apply rewards at checkout) · Square Help (Manage your Square Loyalty program) และ
Square Community/Developer Forum (refunds, expiry) · Booksy (No-Show Protection, Digital Loyalty Cards) · Vagaro (customer loyalty programs)
