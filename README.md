# Kiwmee (คิวมี) — ระบบจองคิวออนไลน์และบัตรสมาชิกสำหรับธุรกิจบริการ

[![CI](https://github.com/praphawach29/kiwmee/actions/workflows/ci.yml/badge.svg)](https://github.com/praphawach29/kiwmee/actions/workflows/ci.yml)
[![Repository](https://img.shields.io/badge/GitHub-praphawach29%2Fkiwmee-blue?logo=github)](https://github.com/praphawach29/kiwmee)
[![Production](https://img.shields.io/badge/Production-kiwmee.up.railway.app-green)](https://kiwmee.up.railway.app)

**Kiwmee** คือแพลตฟอร์มระบบจองคิวออนไลน์ (Online Booking) ผสานระบบสมาชิกและคะแนนสะสม (Loyalty & Rewards) สำหรับร้านเสริมสวย คลินิก ร้านตัดผม สปา สนามกีฬา และธุรกิจบริการทุกประเภท ใช้งานง่ายผ่านเว็บและเชื่อมต่อ **LINE Official Account (LIFF)** เต็มรูปแบบ

- **GitHub Repository:** [https://github.com/praphawach29/kiwmee.git](https://github.com/praphawach29/kiwmee.git)
- **Production URL:** [https://kiwmee.up.railway.app](https://kiwmee.up.railway.app)

---

## ฟีเจอร์หลัก (Key Features)

### ฝั่งลูกค้า (Customer Experience · Web & LINE LIFF)
1. **ระบบจองคิว 4 ขั้นตอน (Step 1–4):**
   - ขั้นตอน 1: เลือกบริการ (พร้อมหมวดหมู่, ตัวเลือกเสริม, ราคา และมัดจำ)
   - ขั้นตอน 2: เลือกช่าง / สนาม และวันเวลาว่างแบบเรียลไทม์ (ป้องกันคิวชน 100%)
   - ขั้นตอน 3: ข้อมูลผู้จอง, สรุปนัดหมาย, สิทธิประโยชน์ และส่วนลดคะแนนสะสม
   - ขั้นตอน 4: จองสำเร็จ, บัตร Kiwmee Pass, QR เช็คอิน และปุ่มเพิ่มลงปฏิทิน
2. **บริการและราคา (Services & Price Catalog):** แสดงรายการบริการ อัตราค่าบริการ รายละเอียด และระยะเวลา
3. **การจองของฉัน & บัตรสมาชิก (My Bookings & Member Pass):**
   - ตรวจสอบสถานะนัดหมาย, เลื่อนนัด, หรือยกเลิกนัดได้ด้วยตนเอง
   - บัตรสมาชิกดิจิทัล (Classic, Silver, Gold, Platinum), แสดงคะแนนสะสม, สิทธิประโยชน์ และของรางวัล
4. **รีวิวและให้คะแนน (Post-service Review & Rating):** ให้คะแนน 1–5 ดาว พร้อมข้อเสนอแนะและติดแท็กความประทับใจ
5. **การแจ้งเตือนผ่าน LINE (Flex Messages):** ส่งการ์ดแจ้งเตือนการจองสำเร็จ, การยืนยันมัดจำ, การแจ้งเตือนก่อนถึงเวลานัด และการคืนเงิน

### ฝั่งร้านค้า (Merchant Dashboard)
- แดชบอร์ดภาพรวม จัดการแบรนด์และหลายสาขา (Multi-branch)
- ปฏิทินและการจัดการคิวรายวัน (รับคิว, เลื่อนนัด, ยกเลิก, ปิดรอบบริการ)
- จัดการบริการ ช่างผู้ให้บริการ สนาม/สิ่งอำนวยความสะดวก และเวลาทำการ
- จัดการเงินมัดจำ บัญชีโอนเงิน และระบบตรวจสลิป EasySlip อัตโนมัติ
- ปิดบิล คิดเงินหน้าร้าน และสรุปรายรับประจำวัน
- สแกน QR Code สำหรับเช็คอินลูกค้าและสะสมคะแนนหน้าร้าน

---

## สถาปัตยกรรมระบบ (Tech Stack)

- **Frontend & Fullstack Framework:** [Next.js 15](https://nextjs.org/) (App Router), [React 19](https://react.dev/)
- **Database:** [PostgreSQL 16](https://www.postgresql.org/) บน [Supabase](https://supabase.com/) พร้อม Row Level Security (RLS) แยกสิทธิ์ร้านค้าและผู้ใช้
- **Messaging & Identity:** LINE Messaging API, LINE Front-end Framework (LIFF), LINE Login
- **Styling:** Modern CSS Tokens, Mobile-First Responsive Design (Brand Theme: Mitr / Anuphan)
- **Deployment:** [Railway](https://railway.app/) (Continuous Deployment จากกิ่ง `main`)

---

## การพัฒนาและทดสอบ (Development & Testing)

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. รัน Unit Tests (ไม่ต้องต่อ Database)
```bash
npm test
```

### 3. รัน Database Integration Tests (ต้องการ Postgres จำลอง)
```bash
SUPABASE_TEST_DB_URL=postgres://postgres@127.0.0.1:54329/booking_test npm run test:db
```

### 4. ตรวจสอบการ Build (Production Build Check)
```bash
npx next build
```

---

## เอกสารอ้างอิงของโปรเจกต์ (Project Documentation)

อ่านเอกสารรายละเอียดเพิ่มเติมในโฟลเดอร์ `docs/`:
- [`CLAUDE.md`](./CLAUDE.md) — กติกาการพัฒนาและมาตรฐานโค้ดของโปรเจกต์
- [`docs/HANDOFF.md`](./docs/HANDOFF.md) — สรุปสถานะงานล่าสุด รายการ PR และ Roadmap
- [`docs/FLEXIBLE_BOOKING_DESIGN.md`](./docs/FLEXIBLE_BOOKING_DESIGN.md) — เอกสารการออกแบบเครื่องคำนวณคิวว่างและ Flow การจอง
- [`docs/LOYALTY_DESIGN.md`](./docs/LOYALTY_DESIGN.md) — เอกสารออกแบบระบบสมาชิก คะแนนสะสม และ LINE Flex Cards
- [`docs/BRAND_COLORS.md`](./docs/BRAND_COLORS.md) — คู่มืออัตลักษณ์แบรนด์ Kiwmee (สี, ฟอนต์, สไตล์)
