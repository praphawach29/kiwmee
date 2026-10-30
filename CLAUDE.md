# Kiwmee — กติกาการทำงานใน repo นี้

**เริ่ม session ใหม่: อ่าน `docs/HANDOFF.md` ก่อนทุกครั้ง** (สถานะงาน, สิ่งที่ตัดสินใจแล้ว, ขั้นต่อไป, วิธีเตรียมเครื่อง)

## กติกาของเจ้าของโปรเจกต์

- **ตอบเป็นภาษาไทยเสมอ**
- ทำงานบน branch แล้วเปิด PR · **merge เฉพาะเมื่อเจ้าของสั่งเท่านั้น** (squash merge, ชื่อ commit ลงท้าย `(#เลข PR)`)
- **ห้ามแตะ Supabase v1** (`rdbzdshvlfxenpsiyjzl`) — บอท LINE เดิมยังใช้อยู่ ชื่อตารางชนกับ v2
- ฐานข้อมูลจริงคือ Supabase **booking-v2** (`ezubgqeqdipwfnmorqkj`) · เครื่องมือ Supabase ในแชทเข้าโปรเจกต์นี้ไม่ได้
  → migration ใหม่เขียนเป็นไฟล์ใน `supabase/migrations/` แล้ว**ส่ง SQL ทั้งไฟล์ให้เจ้าของรันเองใน SQL Editor** ก่อน merge
  (โค้ดที่อ่านคอลัมน์ใหม่จะพังถ้า merge ก่อนรัน SQL)
- ห้ามแก้ฐานข้อมูลด้วยมือโดยไม่มีไฟล์ migration · ทุกตารางใหม่ต้องมี RLS และเทสต์ (anon อ่านไม่ได้, ร้าน A แตะร้าน B ไม่ได้)
- merge เข้า `main` = deploy อัตโนมัติไป Railway (`kiwmee.up.railway.app`)

## ก่อนเปิด PR ต้องผ่าน

```bash
npm test                                   # unit tests (ข้ามเทสต์ที่ต้องใช้ DB)
SUPABASE_TEST_DB_URL=postgres://postgres@127.0.0.1:54329/booking_test npm run test:db
npx next build
```
วิธีเปิด Postgres ทดสอบและ Playwright ในเครื่อง cloud: `docs/HANDOFF.md` §5

## โค้ดที่ควรรู้

- v2 (ของใหม่ทั้งหมด): `src/v2/*`, `app/b/[slug]/*` (หน้าจองลูกค้า), `app/dashboard/*` (แอดมินร้าน), `app/api/b/**`, `app/api/dashboard/**`, `supabase/`
- v1 (ของเดิม ยังไม่ลบ): `src/` นอก `src/v2`, `app/admin`, `app/manage`, `app/api/admin`, `database/` — อย่าต่อยอดของ v1
- แบรนด์: `docs/BRAND_COLORS.md` (ม่วง #6A4CFF + มินต์ #3DDC97, ฟอนต์ Mitr/Anuphan, โลโก้ `public/brand/`)
- เอกสารออกแบบ: `docs/FLEXIBLE_BOOKING_DESIGN.md` (ระบบจอง ขั้น 1–5), `docs/LOYALTY_DESIGN.md` (LINE, แบรนด์/สาขา, บิล, คะแนน, ระดับสมาชิก, แพ็กเกจ)
