# supabase/ — ฐานข้อมูล v2 (ระบบจองยืดหยุ่น หลายร้าน)

ออกแบบตาม `docs/FLEXIBLE_BOOKING_DESIGN.md` · โค้ดเดิมใน `database/` และ `src/` ยังใช้ schema v1 อยู่
จะย้ายมาใช้ตารางชุดนี้ในขั้นที่ 2–6

| ไฟล์ | คืออะไร |
|---|---|
| `migrations/20261025000000_tenancy.sql` | ร้าน, สมาชิก (owner/staff), ฟังก์ชันเช็คสิทธิ์ที่ RLS ใช้, `create_business()` |
| `migrations/20261025000100_catalog.sql` | ทรัพยากร, เวลาทำการ, ตารางช่าง, บริการ, ราคา, ขั้นตอนจอง |
| `migrations/20261025000200_bookings.sql` | ลูกค้า, การจอง, ทรัพยากรที่การจองถือ (กันจองซ้อน), ประวัติสถานะ |
| `migrations/20261025000300_booking_rpcs.sql` | RPC จอง / เลื่อน / ยืนยัน / ยกเลิก, hold หมดอายุ, คิดราคา |
| `migrations/20261025000400_public_api_rate_limits.sql` | จำกัดจำนวนครั้งของ API หน้าจอง |
| `migrations/20261025000500_admin.sql` | หน้าแอดมิน: ร้านใหม่ได้เวลาทำการ 7 วันตั้งแต่สร้าง |
| `migrations/20261025000600_custom_resource_kinds.sql` | ชนิดทรัพยากรตั้งชื่อเองได้ (เช่น "เก้าอี้นวด") นอกจาก staff/court/room/equipment |
| `migrations/20261025000700_booking_status.sql` | หน้าการจองของร้าน: `set_booking_status` (มาถึงแล้ว / เสร็จแล้ว / ไม่มา / ย้อนกลับ) |
| `seed.sql` | ร้านตัวอย่าง 2 ร้าน: Bloom Hair & Beauty (เสริมสวย), Gentleman Barber (ตัดผมชาย) |
| `tests/` | ทดสอบ RLS และความถูกต้องของข้อมูล + ไฟล์จำลองสิ่งที่ Supabase มีให้ (เฉพาะทดสอบในเครื่อง) |

## ลงโปรเจกต์ Supabase

```bash
npx supabase link --project-ref <ref ของโปรเจกต์>
npx supabase db push            # ลง migration ตามลำดับ
```
หรือเปิด SQL Editor แล้วรันทีละไฟล์ใน `migrations/` ตามลำดับชื่อ · `seed.sql` ใช้กับโปรเจกต์ทดสอบเท่านั้น

**ห้ามแก้ฐานข้อมูลด้วยมือโดยไม่มีไฟล์ migration** ทุกการเปลี่ยนต้องเป็นไฟล์ใหม่ใน `migrations/`

## ให้เจ้าของร้านเข้าหน้าแอดมิน (`/dashboard`)

เจ้าของร้านสมัครที่ `/dashboard` (หรือเพิ่มใน Supabase → Authentication → Users) แล้วเปิดร้านใหม่เองได้
ร้านที่มีอยู่แล้ว (เช่นร้านตัวอย่างจาก seed) ต้องผูกบัญชีเป็นเจ้าของครั้งแรกใน SQL Editor:

```sql
insert into public.business_members (business_id, user_id, role)
select b.id, u.id, 'owner' from public.businesses b, auth.users u
where b.slug = 'bloom-hair' and u.email = 'อีเมลเจ้าของร้าน'
on conflict (business_id, user_id) do update set role = 'owner';
```
พนักงาน (ดูได้อย่างเดียว) ใช้คำสั่งเดียวกันโดยเปลี่ยน `'owner'` เป็น `'staff'`

## ทดสอบ

ต้องมี Postgres 15+ ในเครื่อง (มี `btree_gist`) สคริปต์สร้างฐานข้อมูลใหม่ทุกครั้งจาก migration + seed

```bash
SUPABASE_TEST_DB_URL=postgres://postgres@127.0.0.1:54329/booking_test npm run test:db
```

ทุกตารางใหม่ต้องมีในการทดสอบ: anon อ่านไม่ได้ · ร้าน A อ่าน/เขียนร้าน B ไม่ได้
