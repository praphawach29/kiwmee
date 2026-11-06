# ปลดระวางโค้ด v1 (Phase 5)

สถานะ: **ลบแล้ว** (PR #90) — เก็บประวัติไว้ที่ tag `pre-v1-removal` · webhook เดิมเหลือ route ตอบ 410 ไว้เป็นป้ายบอกทาง

## สถานะ

- ร้าน/แอดมิน v1, `src/` เดิม, `database/`, เทสต์/สคริปต์ v1 และเอกสาร `ai/ api/ automation/ pilot/ prompts/ ui/ examples/` ถูกลบ
- เก็บไว้เพราะ v2 ยังใช้: `src/errors.js`, `src/http.js`, `src/security/limits.js`, `src/v2/**`
- `app/api/line/webhook` เหลือ stub ตอบ **410 Gone** + log — ถ้ามี channel ไหนยังชี้มาที่นี่จะเห็นใน Railway logs ทันที
- ย้อนกลับ: `git revert <commit>` หรือ deploy จาก tag `pre-v1-removal`

## ทำไมยังลบตอนนี้ไม่ได้

`app/api/line/webhook/route.js` เป็น webhook ของ **บอท LINE ตัวเดิม (v1)** ซึ่ง `CLAUDE.md` ระบุว่ายังใช้งานอยู่
ถ้าลบโค้ดแล้ว merge เข้า `main` → Railway deploy ทับ → webhook นั้นตอบ 404 → บอทเดิมหยุดทำงานทันที

ยังมีอีกจุดที่ผูกกับ v1: `app/api/admin/*`, `app/admin`, `app/manage`, `src/` (นอก `src/v2`), `database/migrations`,
และตารางใน Supabase v1 (`rdbzdshvlfxenpsiyjzl`) ที่ห้ามแตะ

## ตรวจก่อนปลดระวาง (เจ้าของทำ)

1. **LINE Developers → Messaging API channel เดิม → Webhook URL** — ยังชี้มาที่ `https://kiwmee.up.railway.app/api/line/webhook` หรือไม่
2. **Railway → service `salon-booking-os-v1` → Deploy logs** — มี request เข้า `/api/line/webhook` ใน 7 วันล่าสุดไหม
3. ถ้ายังมี → ย้าย webhook ไประบบใหม่ หรือปิดบอทก่อน แล้วค่อยลบโค้ด
4. ถ้าไม่มีมานานแล้ว → ลบได้ แต่ควรเก็บ tag ไว้กู้คืน

## สิ่งที่จะลบ (เมื่อได้ไฟล์เขียว)

| กลุ่ม | ไฟล์ |
|---|---|
| หน้าเว็บ v1 | `app/admin/**`, `app/manage/**`, `app/assistant/**` (ถ้าไม่ใช้) |
| API v1 | `app/api/admin/**`, `app/api/line/**`, `app/api/bookings/**`, `app/api/availability/**`, `app/api/staff/**`, `app/api/services/**`, `app/api/ai/**`, `app/api/internal/**`, `app/api/health` (ใช้ `src/v2/health` แล้ว — เก็บไว้) |
| โค้ด v1 | `src/` ทุกไฟล์ **ยกเว้น** `src/v2/**` |
| ฐานข้อมูล v1 | `database/**` (เก็บไว้เป็นประวัติได้ แต่ไม่ใช้) |
| เทสต์/สคริปต์ v1 | `tests/*` ที่ require `src/` เดิม, `scripts/` ที่เกี่ยวกับ pilot/automation |

**ห้ามลบ:** `src/v2/**`, `app/b/**`, `app/dashboard/**`, `app/super/**`, `app/privacy`, `app/terms`,
`app/api/b/**`, `app/api/dashboard/**`, `app/api/super/**`, `supabase/**`, `public/**`

## ลำดับที่ปลอดภัย

1. ตั้ง tag สำรอง: `git tag pre-v1-removal`
2. ปิด/ย้าย webhook ของบอทเดิม (ข้อ 1–3 ด้านบน)
3. ลบเป็น **PR เดียว** เฉพาะโฟลเดอร์ v1 + เทสต์ที่อ้างถึง (ไม่ปนงานอื่น)
4. รัน `npm test`, `SUPABASE_TEST_DB_URL=… npm run test:db`, `npx next build` — ถ้ามี import ค้างจะพังที่นี่
5. merge → ตรวจ production: `/`, `/b/<slug>`, `/dashboard`, `/super`, `/api/health`
6. ถ้าพลาด: `git revert` หรือ deploy จาก tag `pre-v1-removal`

## คำสั่งตรวจ import ที่ยังชี้ไป v1

```bash
# ไฟล์ v2 ที่ยัง require ของ v1 (ควรว่าง)
git grep -n "require(\"\.\./\.\./src/" -- app/b app/dashboard app/super app/api/b app/api/dashboard app/api/super || true

# ไฟล์ v1 ที่ยังถูกอ้างจากที่อื่น
git grep -n "src/config\|src/repositories\|src/payment" -- app/b app/dashboard app/super || true
```

## หมายเหตุ

- การลบโค้ด **ไม่ลบข้อมูล** ใน Supabase v1 — โปรเจกต์ v1 ยังอยู่จนกว่าเจ้าของจะปิดเอง (ห้ามรัน SQL ที่นั่น)
- ก่อนลบ ควรมีคนยืนยันว่าไม่มี job/cron ภายนอก (เช่น automation worker) ชี้มาที่ endpoint v1
