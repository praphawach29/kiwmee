# Pilot #1: Pre-flight Verification Checklist

เอกสารตรวจสอบความพร้อมของระบบ (Pre-flight Checklist) ก่อนเริ่มเปิดใช้งาน Pilot #1 กับร้านเสริมสวยจริง

---

## 1. คำสั่งตรวจสอบอัตโนมัติ (Automated Pre-flight Command)

รันคำสั่งตรวจสอบความพร้อมของระบบและการตั้งค่าทั้งหมด:

```bash
npm run pilot:preflight
```

หรือตรวจสอบความสมบูรณ์ของ Production Configuration เฉพาะส่วน:

```bash
npm run config:check
```

---

## 2. ตารางตรวจสอบ Pre-flight (Manual & Automated Gates)

### หมวดที่ 1: Environment & Configuration
- [ ] คัดลอกและตั้งค่าตาม `pilot/.env.pilot.example` ไปยัง Environment ของ Server หรือ Platform
- [ ] ตั้งค่า `PILOT_STRICT_CONFIG=true` เพื่อเปิดโหมดตรวจสอบความถูกต้องของ Configuration ขั้นเด็ดขาด
- [ ] กำหนด `BUSINESS_NAME`, `BUSINESS_CONTACT`, และ `HANDOFF_DESTINATION` ชัดเจน
- [ ] ตรวจสอบ `BUSINESS_TIMEZONE=Asia/Bangkok` และรองรับ IANA timezone format
- [ ] รหัสผ่าน Admin ถูกแปลงเป็น Hash แบบ scrypt แล้ว (`ADMIN_PASSWORD_HASH`) ด้วยคำสั่ง:
  ```bash
  ADMIN_PASSWORD_PLAIN='รหัสผ่านความยาว12ตัวอักษรขึ้นไป' npm run admin:hash-password
  ```
- [ ] `ADMIN_SESSION_SECRET` มีความยาวอย่างน้อย 32 ตัวอักษร
- [ ] `AUTOMATION_INTERNAL_SECRET` มีความยาวอย่างน้อย 32 ตัวอักษร

---

### หมวดที่ 2: Database & Schema Integrity
- [ ] มีการเชื่อมต่อฐานข้อมูล PostgreSQL ผ่าน `DATABASE_URL` (และ `PGSSL=true` หากใช้ Cloud DB เช่น Supabase)
- [ ] เปิด Extensions ที่จำเป็นแล้ว:
  ```sql
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  CREATE EXTENSION IF NOT EXISTS "btree_gist";
  ```
- [ ] รัน Migration ครบถ้วนตามลำดับ:
  1. `database/schema.sql` (สำหรับ DB ใหม่)
  2. หรือรัน `004_automation_jobs.sql`, `005_automation_retry.sql`, `006_pilot_hardening.sql` (สำหรับ DB ที่อัปเกรด)
- [ ] ตรวจสอบว่าตารางทั้ง 13 ตารางมีอยู่จริงใน `public` schema:
  - `services`, `staff`, `staff_services`, `availability`
  - `bookings`, `booking_status_history`
  - `automation_jobs`, `automation_logs`
  - `ai_sessions`, `rate_limits`, `handoff_requests`
  - `admin_session_revocations`, `line_webhook_events`
- [ ] มี Exclusion Constraint ป้องกันเวลาชน: `bookings_no_staff_overlap` บนตาราง `bookings`
- [ ] นำเข้าข้อมูลตั้งต้นของร้าน Pilot:
  ```bash
  psql "$DATABASE_URL" -f pilot/database/pilot_salon_seed.sql
  ```

---

### หมวดที่ 3: Code & Build Verification
- [ ] รันชุดทดสอบ Regression:
  ```bash
  npm test
  ```
  *(ผลการทดสอบต้องผ่านทั้งหมด 44 unit tests และ 0 failed)*
- [ ] รัน Production Build:
  ```bash
  npm run build
  ```
  *(ต้องผ่านโดยไม่มี Type error หรือ Route generation error)*

---

### หมวดที่ 4: Endpoint Health & Connectivity
- [ ] เมื่อ Deploy ขึ้นเซิร์ฟเวอร์แล้ว ให้ทดสอบ Health endpoint:
  ```bash
  curl -i https://your-domain.example/api/health
  ```
  **ผลลัพธ์ที่ถูกต้อง**:
  - HTTP Status: `200 OK`
  - JSON Response:
    ```json
    {
      "status": "ok",
      "database": "ready",
      "business": "Luxe Hair & Beauty Studio",
      "ai": "mock",
      "line": "disabled"
    }
    ```
- [ ] ตรวจสอบว่า Response ของ `/api/health` ไม่มีการเปิดเผย Secrets, Connection String หรือรหัสผ่านใดๆ ออกมา

---

### หมวดที่ 5: Security & Permissions Gate
- [ ] ทดสอบเข้า `/api/bookings/{id}` โดยไม่มี Header `x-booking-phone` ต้องได้ **HTTP 403 Forbidden**
- [ ] ทดสอบเข้า `/api/admin/bookings` โดยไม่มี Admin Session Cookie ต้องได้ **HTTP 401 Unauthorized** หรือ Redirect ไปหน้า Login
- [ ] ทดสอบเรียก `/api/internal/automation/run` โดยไม่มี Header `Authorization: Bearer <secret>` หรือ `x-automation-secret` ต้องได้ **HTTP 403 Forbidden**
