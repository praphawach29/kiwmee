# คะแนนสะสม + บัญชีลูกค้าผ่าน LINE — Design

สถานะ: **ออกแบบ ยังไม่เริ่มทำ** · 27 ต.ค. 2569 · ต่อจาก `docs/FLEXIBLE_BOOKING_DESIGN.md` (ขั้นที่ 1–5 เสร็จแล้ว)

**ตัดสินใจแล้ว** (27 ต.ค. 2569):

1. คะแนน**ใช้ได้ทุกสาขาของแบรนด์เดียวกัน** (เช่น ร้านก๋วยเตี๋ยว 5 สาขา) และแบรนด์จำกัดให้ได้/ใช้คะแนนเฉพาะบางสาขาได้
2. **ร้านออกแบบกติกาเอง**: ได้คะแนนเท่าไหร่ต่อยอดใช้จ่าย และแลกอะไรได้ (ใช้ฟรี 1 ครั้ง หรือเป็นส่วนลด)
3. ลูกค้า**เลือกใช้คะแนนตอนชำระเงิน**
4. คะแนน**มีวันหมดอายุ** ร้านกำหนดเอง
5. ยืนยันตัวตนลูกค้าด้วย **LINE อย่างเดียว** (ไม่ทำ OTP เบอร์โทร) · ใช้ LINE ส่งการ์ดยืนยัน/เตือนนัดไปด้วย

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
- **ได้คะแนนเฉพาะการจองที่ผูก LINE** · ลูกค้าที่จองทางเว็บ/ร้านบันทึกให้ ได้คะแนนเมื่อผูก LINE ทีหลัง (ข้อ 5: QR สมาชิก)

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
  active boolean not null default true
);
```

- **คิดคะแนนจากยอดที่จ่ายจริง** (หลังหักส่วนลดจากคะแนน) ปัดลง: 250 บาท, ทุก 100 ได้ 10 → 20 คะแนน
- `per_visit` = บัตรสะสมตรา: มาครบ 10 ครั้ง (`earn_points` 1, รางวัล `points_cost` 10)
- เปลี่ยนกติกาแล้ว**ไม่คิดย้อนหลัง** คะแนนที่ได้ไปแล้วคงเดิม

---

## 4. สมุดบัญชีคะแนน (ledger)

คะแนนคงเหลือ**ไม่เก็บเป็นตัวเลขตัวเดียว** แต่รวมจากรายการทั้งหมด ตรวจย้อนได้ทุกแต้มว่ามาจากไหน ไปไหน

```sql
create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id),
  line_user_id text not null,
  business_id uuid not null,                    -- สาขาที่เกิดรายการ
  booking_id uuid references public.bookings(id),
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

**ได้คะแนน** — trigger บน `bookings` ตอนสถานะเปลี่ยนเป็น `completed`:
มี `line_user_id` + โปรแกรมเปิด + สาขา `can_earn` → เขียน `earn` พร้อม `expires_at = now() + expire_months`
· ร้านกด "ย้อนกลับ" (completed → checked_in, มีแล้วใน `set_booking_status`) → เขียน `reverse` คืนแต้มที่ได้

**หมดอายุ** — ใช้คะแนนจากล็อตที่หมดอายุก่อนเสมอ (FIFO) · งานรายวัน (pg_cron) เขียน `expire` ให้ล็อตที่หมดอายุแล้วยังเหลือแต้ม
· หน้า "ของฉัน" เตือน "xx คะแนนจะหมดอายุ dd/mm"

---

## 5. ใช้คะแนนตอนชำระเงิน

ใช้ขั้น `payment` ของ flow (ตอนนี้ยังเลือกไม่ได้) เป็นที่เลือกรางวัล · ร้านที่ให้จ่ายหน้าร้านก็ใช้ได้

```
เลือกบริการ/เวลา → ขั้นชำระเงิน: "ใช้ 100 คะแนน แลก ส่วนลด 100 บาท" ☐ → ยืนยัน
  1. hold:    กันแต้มไว้กับการจอง (ยังไม่ตัดจริง) · price_snapshot เก็บยอดก่อน/หลังส่วนลด
  2. redeem:  ร้านกด "เสร็จแล้ว" → แต้มที่กันไว้ถูกใช้จริง แล้วคิดคะแนนใหม่จากยอดหลังหักส่วนลด
  3. release: ยกเลิก / hold หมดเวลา → คืนแต้มที่กันไว้
```

- จ่ายออนไลน์ (เมื่อย้ายระบบชำระเงินมา): ยอดที่ต้องโอน = ยอดหลังหักส่วนลด
- **walk-in / ร้านบันทึกเอง**: พนักงานสแกน QR สมาชิกในหน้าการจอง → ผูกการจองกับ LINE → เลือกรางวัลให้ได้ (ข้อ 1)
- ฐานข้อมูลตรวจซ้ำตอน hold: แต้มพอ · รางวัลใช้ได้ที่สาขานี้ · ใช้กับบริการนี้ได้ (free_offering) · 1 การจองใช้ได้ 1 รางวัล

---

## 6. ลำดับการทำ

| ขั้น | งาน | ต้องมีก่อน |
|---|---|---|
| 6a | LIFF: ล็อกอิน LINE ในหน้าจอง · การ์ดยืนยันการจอง · การ์ดเตือนก่อนนัด (ปุ่มเลื่อน/ยกเลิกเปิดหน้าที่ทำแล้ว) | **LINE Login channel + LIFF app + Messaging API channel** (ผู้ใช้สร้าง) |
| 6b | หน้า "ของฉัน" (`/me`): นัดที่จะถึง + ประวัติ ข้ามร้าน | 6a |
| 6c | แบรนด์/สาขา: ตาราง `brands`, ย้ายร้านเดิม, ปุ่มเพิ่มสาขา, เจ้าของแบรนด์ | — (ทำคู่กับ 6a ได้) |
| 6d | ตั้งกติกาคะแนน (หน้าแอดมิน) · ได้คะแนนตอน `completed` · คืนตอนย้อนกลับ · หมดอายุ · แสดงใน `/me` | 6b, 6c |
| 6e | ขั้น `payment`: เลือกรางวัล, hold/redeem/release · QR สมาชิกสำหรับ walk-in | 6d |
| 6f | ย้ายระบบชำระเงิน/ตรวจสลิปของ v1 มาใช้กับ v2 (ยอดหลังหักส่วนลด) | 6e |

ทดสอบที่ต้องมี (ตามกติกาเดิม: anon อ่านไม่ได้, ข้ามแบรนด์ไม่ได้): กดใช้คะแนนพร้อมกัน 2 เครื่องตัดได้ครั้งเดียว ·
ย้อนสถานะแล้วคะแนนถูกคืน · ล็อตเก่าหมดอายุก่อน · สาขาที่ปิด can_redeem แลกไม่ได้ · ID token ปลอมเข้า `/me` ไม่ได้

---

## 7. คำถามที่ยังต้องตอบ

1. **ไม่มาตามนัด (no-show)** ที่กันคะแนนไว้: คืนคะแนน หรือริบ (ให้ร้านเลือก?)
2. **ใช้หลายรางวัลในการจองเดียว** ได้ไหม (เช่น ส่วนลด 100 สองครั้ง) — แบบร่างให้ 1 รางวัลต่อการจอง
3. **คะแนนเศษ**: 150 บาท ทุก 100 ได้ 10 → ได้ 10 (ปัดลง) หรือ 15 (คิดเป็นสัดส่วน) — แบบร่างปัดลง
4. **ร้านแจกคะแนนเอง** (โปรวันเกิด, ขอโทษลูกค้า) — แบบร่างมี `adjust` ให้เจ้าของแบรนด์เท่านั้น
5. **ค่าบริการของ Kiwmee**: ระบบคะแนนเป็นฟีเจอร์แพ็กเกจเสียเงินหรือเปล่า (มีผลกับหน้าตั้งค่า)
