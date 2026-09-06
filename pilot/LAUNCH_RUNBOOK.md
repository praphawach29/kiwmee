# Pilot #1: Launch Runbook

คู่มือขั้นตอนการปล่อยระบบขึ้นใช้งานจริง (Launch Runbook) สำหรับร้านนำร่องแห่งแรก (**Luxe Hair & Beauty Studio**) บน **Salon Booking OS v1**

---

## 1. ลำดับเวลาและขั้นตอนภาพรวม (Launch Timeline)

| ระยะเวลา | ขั้นตอนหลัก | ผู้รับผิดชอบ | สถานะ |
| :--- | :--- | :--- | :---: |
| **T-3 วัน** | เตรียมฐานข้อมูล PostgreSQL + รัน Schema & Seed | วิศวกรระบบ | [ ] |
| **T-2 วัน** | เตรียม Environment Secrets + ทดสอบ Pre-flight | วิศวกรระบบ | [ ] |
| **T-1 วัน** | ซักซ้อมพนักงานร้าน (Admin UI / Manage Flow) | เจ้าของร้าน / ผู้จัดการ | [ ] |
| **T-0 วัน (Go-Live)** | Deploy Production, ตรวจสอบ Health, รัน Day-1 Smoke Tests | วิศวกร + เจ้าของร้าน | [ ] |
| **T+1 ถึง T+7 วัน** | สังเกตการณ์ Automation Jobs, No-show และ Handoff | วิศวกร + ผู้จัดการร้าน | [ ] |

---

## 2. ขั้นตอนการเตรียมระบบและการ Deploy (Step-by-Step Runbook)

### ขั้นตอนที่ 1: เตรียมฐานข้อมูล (Database Provisioning & Migration)
1. ติดตั้งหรือเตรียมฐานข้อมูล PostgreSQL (แนะนำ PostgreSQL 15+ หรือ Supabase)
2. รันคำสั่งโครงสร้างฐานข้อมูล (Fresh Database):
   ```bash
   psql "$DATABASE_URL" -f database/schema.sql
   ```
   *(หากเป็นฐานข้อมูลที่มีอยู่เดิมจาก Phase ก่อนหน้า ให้รัน migrations ในโฟลเดอร์ `database/migrations/` ตามลำดับ)*
3. นำเข้าข้อมูลเฉพาะของร้าน Pilot #1:
   ```bash
   psql "$DATABASE_URL" -f pilot/database/pilot_salon_seed.sql
   ```
4. ตรวจสอบข้อมูลในตาราง:
   ```sql
   SELECT count(*) FROM services WHERE active = true; -- ต้องได้ 5 รายการ
   SELECT count(*) FROM staff WHERE active = true;    -- ต้องได้ 3 ท่าน
   SELECT count(*) FROM availability;                 -- ต้องมีกะทำงานพร้อม
   ```

---

### ขั้นตอนที่ 2: การสร้าง Secrets และ Environment Variables
1. สร้างรหัสผ่าน Admin และแปลงเป็น scrypt hash:
   ```bash
   ADMIN_PASSWORD_PLAIN='ตั้งรหัสผ่านที่มีความปลอดภัยสูง12ตัวขึ้นไป' npm run admin:hash-password
   ```
   *นำสตริงที่ได้ขึ้นต้นด้วย `scrypt$...` ไปใส่ใน `ADMIN_PASSWORD_HASH`*
2. สร้างสุ่ม Secrets สำหรับ Session และ Runner (ความยาวขั้นต่ำ 32 ตัวอักษร):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   *สร้าง 2 ค่าแยกกัน: สำหรับ `ADMIN_SESSION_SECRET` และ `AUTOMATION_INTERNAL_SECRET`*
3. กำหนดค่าใน Environment Variables ของโฮสต์หรือ `.env.local` ตามตัวอย่างใน `pilot/.env.pilot.example`
4. ตั้งค่าโหมดความปลอดภัย:
   ```env
   PILOT_STRICT_CONFIG=true
   AI_PROVIDER=mock
   LINE_ENABLED=false
   ```
   *(หมายเหตุ: ในวันแรกเริ่มเปิดใช้งาน แนะนำให้ใช้ `AI_PROVIDER=mock` และ `LINE_ENABLED=false` ก่อนเพื่อทดสอบ Flow หลักจนเสร็จสิ้น จากนั้นจึงสลับเป็น `openai` และเปิด LINE)*

---

### ขั้นตอนที่ 3: ตรวจสอบความพร้อมก่อนรัน (Pre-flight Execution)
รันคำสั่งตรวจสอบ:
```bash
npm run pilot:preflight
```
ผลการตรวจสอบต้องขึ้นว่า `✔ ALL PRE-FLIGHT CHECKS PASSED`

---

### ขั้นตอนที่ 4: การตั้งค่า Automation Worker & Scheduler
เลือกติดตั้งตัวรัน Automation อย่างใดอย่างหนึ่ง:

#### ทางเลือก A: ตั้งค่า Cron Job บนเซิร์ฟเวอร์ (รันทุก 1–2 นาที)
```cron
*/2 * * * * cd /path/to/app && DATABASE_URL="..." npm run automation:run >> /var/log/salon-automation.log 2>&1
```

#### ทางเลือก B: ตั้งค่า HTTP Scheduler (เช่น Cloudflare Worker, Upstash QStash, หรือ Cron-Job.org)
ยิง HTTP POST ไปที่:
```http
POST https://your-domain.example/api/internal/automation/run
Authorization: Bearer <ค่า AUTOMATION_INTERNAL_SECRET>
```

---

### ขั้นตอนที่ 5: การเปิดใช้งาน LINE Official Account (เมื่อพร้อม)
1. ในหน้า [LINE Developers Console](https://developers.line.biz/):
   - คัดลอก `Channel Secret` ใส่ใน `LINE_CHANNEL_SECRET`
   - สร้าง `Channel Access Token` (Long-lived) ใส่ใน `LINE_CHANNEL_ACCESS_TOKEN`
   - กำหนด Webhook URL เป็น:
     ```text
     https://your-domain.example/api/line/webhook
     ```
   - เปิดใช้งาน **Use Webhook** และเปิด **Auto-reply messages = OFF** (ใน LINE Official Account Manager)
2. อัปเดต Environment:
   ```env
   LINE_ENABLED=true
   ```
3. รีสตาร์ตแอปพลิเคชัน

---

## 3. เกณฑ์การตัดสินใจ Go / No-Go Gate

ก่อนเปิดให้ลูกค้าทั่วไปเข้าจอง ต้องผ่านเกณฑ์ทั้งหมดดังนี้:

| ลำดับ | รายการเกณฑ์ | ผลการประเมิน |
| :---: | :--- | :---: |
| 1 | `npm run pilot:preflight` ผ่าน 100% | ผ่าน / ไม่ผ่าน |
| 2 | เข้าหน้า `/api/health` ได้ status: "ok", database: "ready" | ผ่าน / ไม่ผ่าน |
| 3 | ทดสอบจองผ่านหน้าเว็บ Customer UI สำเร็จ | ผ่าน / ไม่ผ่าน |
| 4 | หน้า `/admin` ล็อกอินด้วยรหัสผ่านใหม่ได้ และเห็นรายการจอง | ผ่าน / ไม่ผ่าน |
| 5 | ทดสอบ Trigger Automation Runner สำเร็จโดยไม่เกิด Error | ผ่าน / ไม่ผ่าน |
| 6 | ผู้จัดการร้านมีเบอร์ติดต่อรับเคส Handoff สแตนด์บายพร้อม | ผ่าน / ไม่ผ่าน |

> **คำเตือน**: หากข้อใดข้อหนึ่งไม่ผ่าน ให้ระงับการเปิดใช้งานชั่วคราวและแก้ไขตามขั้นตอน Fallback ทันที
