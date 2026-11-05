# Backup และการซ้อมกู้คืน (booking-v2)

สถานะ: **ยังไม่เคยทดสอบ restore** — เป็นข้อค้างข้อสุดท้ายของ Phase 0 ใน `docs/SALES_READINESS_ROADMAP.md`
เอกสารนี้คือขั้นตอนที่ทำให้ตอบได้ว่า "ถ้าฐานข้อมูลหายวันนี้ เรากลับมาได้ในกี่นาที และข้อมูลหายแค่ไหน"

## 1. อะไรอยู่ใน backup อะไรไม่อยู่

| อยู่ไหน | มีอะไร | backup อย่างไร |
|---|---|---|
| ฐานข้อมูล booking-v2 | การจอง บิล คะแนน สมาชิก ระดับ รางวัล เอกสารเช่า (เข้ารหัส) การตั้งค่า LINE (เข้ารหัส) | `pg_dump` / backup ของ Supabase |
| Supabase Storage (`shop-media`) | รูปร้าน บริการ ช่าง สนาม สลิปมัดจำ เอกสารเช่า | **ไม่อยู่ใน dump ของฐานข้อมูล** — ต้องคัดลอก bucket แยก |
| ตัวแปรบน Railway | `BOOKING_DB_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SETTINGS_ENCRYPTION_KEY`, `EASYSLIP_API_KEY` | เก็บใน password manager (ไม่ใช่ใน repo) |

⚠️ **`SETTINGS_ENCRYPTION_KEY` คือกุญแจของข้อมูลที่เข้ารหัสในฐานข้อมูล** (ค่า LINE ใน `platform_settings`, เอกสารเช่าใน `booking_documents`, ลิงก์การจองของลูกค้า) ถ้า restore ฐานข้อมูลแล้วไม่มีคีย์เดิม ข้อมูลเหล่านั้นจะอ่านไม่ได้ถาวร — ต้องเก็บคีย์แยกจากฐานข้อมูล และห้ามเปลี่ยนคีย์โดยไม่มีแผนหมุน

## 2. สามชั้นที่ควรมี

1. **Backup อัตโนมัติของผู้ให้บริการ** — Supabase Dashboard → Database → Backups ตรวจว่าโปรเจกต์ `ezubgqeqdipwfnmorqkj` อยู่แผนไหน: Free ไม่มี backup อัตโนมัติ, Pro ได้รายวัน (เก็บ 7 วัน), PITR เป็น add-on
2. **สำเนาของเราเอง นอก Supabase** — `pg_dump` รายวันไปเก็บที่อื่น (S3/R2/เครื่องอื่น) เข้ารหัสไฟล์ เก็บ 30 วัน
   ถ้าไม่มีสำเนาของตัวเอง การกู้คืนขึ้นกับผู้ให้บริการรายเดียวเท่านั้น
3. **การซ้อมกู้คืนทุกไตรมาส** — backup ที่ไม่เคย restore ไม่ใช่ backup

## 3. ซ้อมกู้คืน (ทำได้เอง ไม่แตะ production)

ต้องมีฐานข้อมูลปลายทางที่ "ว่างแต่มี schema" — เลือกอย่างใดอย่างหนึ่ง:

- **Supabase project ทดลอง** (ฟรี) — มี role `anon/authenticated/service_role` และ schema `auth` ให้แล้ว
- **Postgres ในเครื่อง/cloud** — รัน `psql -f supabase/tests/supabase-shim.sql` ครั้งเดียวก่อน

```bash
# 1) ปลายทางต้องมี schema ของ Supabase ก่อน (ข้ามถ้าใช้ project ทดลอง)
psql "$DRILL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/supabase-shim.sql

# 2) dump ข้อมูลจริง → สร้าง schema ใหม่จาก migrations → restore → ตรวจทีละตาราง
BOOKING_DB_URL="$BOOKING_DB_URL" \
DRILL_DB_URL="postgres://…scratch…" \
  bash scripts/backup-drill.sh
```

สคริปต์จะทำตามลำดับนี้: dump (`--data-only` ของ `public` + `auth.users`) → `drop schema public cascade` แล้วรัน migration ทั้ง 36 ไฟล์ใหม่ → restore → เรียก `scripts/verify-restore.js` เทียบทีละตาราง (จำนวนแถว, RLS, policy, ฟังก์ชัน)

ผลที่ต้องเห็นท้ายสุด:

```
table                     rows      restored  rls
bookings                    128       128  on   ok
…
restore verification passed: 45 tables, 120 functions match
```

ถ้าตารางหาย แถวไม่ครบ RLS หลุด หรือฟังก์ชันหาย สคริปต์จะ exit 1 พร้อมบอกว่าอะไรหาย
`api_rate_limits` ถูกข้ามโดยค่าเริ่มต้น (ตัวเลขเปลี่ยนตลอดเวลาเพราะเป็นตัวนับ rate limit) — เปลี่ยนได้ด้วย `VERIFY_IGNORE="a,b"`

## 4. กู้คืนจริงเมื่อเกิดเหตุ

1. **หยุดการเขียนก่อน** — ปิด service บน Railway (หรือเอา `BOOKING_DB_URL` ออก) เพื่อไม่ให้มีข้อมูลใหม่ทับระหว่างกู้
2. **snapshot สภาพปัจจุบันไว้ก่อนเสมอ** — แม้ฐานจะเสีย การ dump ครั้งสุดท้ายอาจยังกู้บางตารางได้
3. restore ลง **ฐานข้อมูลใหม่** ก่อน ไม่ทับของเดิม แล้วตรวจด้วย `scripts/verify-restore.js` เทียบกับ dump
4. สลับ `BOOKING_DB_URL` มาที่ฐานใหม่ → deploy → เปิด `/api/health` ต้องได้ `status: ok`
5. ทดสอบจริงหนึ่งรอบ: เปิดหน้าจองของร้านทดสอบ → จอง → ปิดบิล → ดูคะแนนเข้า → ยกเลิก → คะแนนคืน
6. ตรวจ Storage: รูปและสลิปยังเปิดได้ (ถ้ากู้ bucket ไม่ครบ ให้กู้จากสำเนา bucket)
7. บันทึกเวลาและสาเหตุไว้ใน `docs/HANDOFF.md`

## 5. PDPA

dump มีข้อมูลลูกค้า (ชื่อ เบอร์ LINE id เอกสารเช่า) จึงต้อง: เข้ารหัสไฟล์ dump, จำกัดคนที่เข้าถึง, ลบตามอายุที่กำหนด (30 วัน), และไม่วางไฟล์ dump ไว้ใน repo หรือโฟลเดอร์ที่แชร์สาธารณะ

## 6. สิ่งที่ CI ตรวจให้ทุก PR

`.github/workflows/ci.yml` job `drill` สร้างฐานข้อมูลจาก migrations + seed แล้วเรียก `scripts/backup-drill.sh` ทั้งชุด → ทุกครั้งที่มี migration ใหม่ เราจะรู้ทันทีว่า backup/restore ยังทำงานได้
