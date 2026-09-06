# Pilot #1: Monitoring & Emergency Procedures

คู่มือการเฝ้าระวังระบบ (Monitoring) และแผนการรับมือเหตุฉุกเฉิน (Emergency & Fallback Procedures) สำหรับ **Salon Booking OS v1**

---

## 1. การเฝ้าระวังระบบ (Continuous Monitoring)

### 1.1 Endpoint สุขภาพระบบ (Health Check Monitoring)
ตั้งค่า Uptime Monitoring (เช่น UptimeRobot, BetterStack หรือ Datadog) ตรวจสอบ URL ทุก 1–2 นาที:
- **URL**: `https://your-domain.example/api/health`
- **คาดหวัง**: HTTP Status 200 และ `{"status":"ok","database":"ready"}`
- **การแจ้งเตือน (Alert)**: หากสถานะเป็น `degraded` หรือได้ HTTP 503 ต่อเนื่องกัน 2 ครั้ง ให้แจ้งเตือนวิศวกรทันที

### 1.2 การตรวจสอบงานอัตโนมัติ (Automation Jobs Health)
รันคำสั่ง SQL ตรวจสอบสถานะงานแจ้งเตือนและติดตามผล:

```sql
-- 1. ตรวจสอบงานที่ตกค้างหรือ Dead-lettered (ไม่สำเร็จเกิน Max Attempts)
SELECT id, booking_id, automation_type, attempts, last_error, dead_lettered_at, created_at
FROM automation_jobs
WHERE dead_lettered_at IS NOT NULL OR status = 'failed'
ORDER BY updated_at DESC;

-- 2. ตรวจสอบงานที่ค้างในสถานะ processing เกิน 5 นาที (อาจเกิดจาก Worker ดับระหว่างส่ง)
SELECT id, booking_id, automation_type, updated_at
FROM automation_jobs
WHERE status = 'processing' 
  AND updated_at < NOW() - INTERVAL '5 minutes';
```

### 1.3 การตรวจสอบคำร้องขอติดต่อคน (Pending Handoffs)
ตรวจสอบคำร้องขอที่ลูกค้ารอการติดต่อกลับจากผู้จัดการร้าน:

```sql
SELECT id, customer_channel, reason, status, created_at
FROM handoff_requests
WHERE status = 'pending'
ORDER BY created_at ASC;
```
*(ผู้จัดการร้านสามารถเข้าดูและกดรับเรื่องได้โดยตรงผ่านแท็บ Handoff ในหน้า `/admin`)*

---

## 2. แผนรับมือเหตุฉุกเฉิน (Emergency Procedures)

### เหตุการณ์ที่ 1: ระบบฐานข้อมูลขัดข้อง (Database Outage / Connection Exhaustion)
- **อาการ**: หน้าเว็บแสดงผลช้า, `/api/health` คืนค่า 503 `{"status":"degraded","database":"unavailable"}`
- **การแก้ไขเร่งด่วน**:
  1. ตรวจสอบสถานะ PostgreSQL หรือ Cloud Provider (เช่น Supabase Dashboard)
  2. หากเกิด Connection Pool เต็ม ให้เปิดใช้งาน Transaction Pooler (`pooler.supabase.com:6543`) หรือปรับจำนวน Connection ใน Client
  3. ตรวจสอบการตั้งค่า `PGSSL=true` ว่าตรงกับความต้องการของ Host หรือไม่
  4. เมื่อฐานข้อมูลกลับมาออนไลน์ ระบบจะสามารถคืนสภาพได้ทันทีโดยไม่ต้องล้างข้อมูลเดิม

---

### เหตุการณ์ที่ 2: ผู้ให้บริการ AI ขัดข้อง (OpenAI Service Degradation)
- **อาการ**: ลูกค้าคุยกับผู้ช่วยที่ `/assistant` แล้วขึ้นข้อความขออภัยหรือเชื่อมต่อไม่ได้ต่อเนื่องกัน
- **การแก้ไขเร่งด่วน (Graceful Fallback)**:
  1. สลับ Provider กลับมาเป็น Deterministic Mock ชั่วคราว:
     ```env
     AI_PROVIDER=mock
     ```
     หรือปิดระบบ AI ชั่วคราวเพื่อให้ระบบแนะนำให้ลูกค้าใช้หน้าเว็บแบบกดเลือกเอง:
     ```env
     AI_ENABLED=false
     ```
  2. รีสตาร์ต Server หรือ Redeploy การตั้งค่า
  3. ลูกค้าจะยังคงสามารถจองผ่าน Customer Web Booking (`/`) ได้ตามปกติ 100% เพราะ Booking Core แยกจาก AI อย่างสิ้นเชิง

---

### เหตุการณ์ที่ 3: งาน Automation ติดขัดหรือเกิด Dead-Letter สะสม
- **อาการ**: ลูกค้าไม่ได้รับ Reminder หรือมีแถวขึ้น `dead_lettered_at` ในตาราง `automation_jobs`
- **การแก้ไข**:
  1. ตรวจสอบข้อความ Error ล่าสุดในคอลัมน์ `last_error`
  2. หากเกิดจากสาเหตุภายนอก (เช่น เครือข่ายชั่วคราว) และปัญหาได้รับการแก้ไขแล้ว:
     ```sql
     -- รีเซ็ตงานเพื่อให้นำกลับมาประมวลผลใหม่ โดยคง event_key เดิมเพื่อป้องกันการส่งซ้ำ
     UPDATE automation_jobs
     SET status = 'pending',
         attempts = 0,
         dead_lettered_at = NULL,
         last_error = NULL,
         scheduled_at = NOW()
     WHERE id = '<JOB_ID>' AND dead_lettered_at IS NOT NULL;
     ```
  3. สั่งรัน Worker ทันที: `npm run automation:run`

---

### เหตุการณ์ที่ 4: รหัสผ่านหรือเซสชัน Admin ถูกละเมิด (Admin Compromise)
- **อาการ**: พบการเข้าถึงที่ไม่ได้รับอนุญาต หรือสงสัยว่ารหัสผ่านรั่วไหล
- **การแก้ไขฉุกเฉิน**:
  1. สร้างรหัสผ่านใหม่และ Hash ทันที:
     ```bash
     ADMIN_PASSWORD_PLAIN='รหัสผ่านใหม่ที่ซับซ้อนและยาวขึ้น' npm run admin:hash-password
     ```
  2. สุ่มสร้าง `ADMIN_SESSION_SECRET` ใหม่ทั้งหมด เพื่อทำให้ Cookie เซสชันเดิมของทุกคนหมดสภาพในทันที
  3. บันทึกยกเลิกเซสชันเดิมลงในตาราง `admin_session_revocations` หรืออัปเดต Environment Variables และรีสตาร์ตระบบ

---

### เหตุการณ์ที่ 5: LINE Webhook ส่งซ้ำหรือ Signature ไม่ถูกต้อง
- **อาการ**: ระบบแจ้ง Signature verification failure หรือมีข้อความซ้ำ
- **การแก้ไข**:
  1. ตรวจสอบว่าใน LINE Official Account Manager ได้ปิด **Auto-reply messages** แล้วหรือไม่
  2. ตรวจสอบ `LINE_CHANNEL_SECRET` ว่าตรงกับที่สร้างไว้ใน LINE Developers Console
  3. หากต้องการปิดรับชั่วคราว ให้ตั้ง `LINE_ENABLED=false` แล้วรีสตาร์ตระบบ
