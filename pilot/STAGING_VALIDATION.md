# Pilot #1: Staging Validation Checklist & Smoke Test Report

เอกสารรายงานการทดสอบความพร้อมระดับ Staging สำหรับการเปิดตัวจริง (Go-Live Readiness) ของร้าน **Luxe Hair & Beauty Studio**

---

## 1. Staging Validation Checklist (6 แกนหลัก)

### 1.1 Health Endpoint (`/api/health`)
- [x] **URL**: `GET /api/health`
- [x] **Database Connectivity**: คืนค่า `"database": "ready"` เมื่อต่อกับ PostgreSQL สำเร็จ
- [x] **Metadata Leak Prevention**: ไม่มีการเปิดเผย Secrets, Connection String, รหัสผ่าน หรือ PII ใน JSON response
- [x] **Feature Flags**: รายงานสถานะ `ai` (mock/openai/disabled) และ `line` (enabled/disabled) ถูกต้องตามการตั้งค่า

### 1.2 Admin Authentication Boundary (`/admin` & `/api/admin/*`)
- [x] **Password Protection**: ต้องผ่านการตรวจสอบด้วย `ADMIN_PASSWORD_HASH` (scrypt format)
- [x] **No Plaintext Storage**: ไม่มีการเก็บหรือเปรียบเทียบรหัสผ่านแบบ Plaintext ในซอร์สโค้ด
- [x] **Session Security**: Session Cookie เป็นแบบ `HttpOnly`, `SameSite=Lax` (หรือ `Secure` บน HTTPS) มีอายุจำกัด
- [x] **Access Protection**: Endpoint `/api/admin/bookings`, `/api/admin/handoffs`, และ `/api/bookings/:id/status` ปฏิเสธคำขอที่ไม่ผ่านการยืนยันตัวตนด้วย HTTP 401 Unauthorized
- [x] **Revocation & Logout**: เมื่อกด Logout มีการบันทึกลงตาราง `admin_session_revocations` ทำให้ Cookie เดิมถูกเพิกถอนทันที

### 1.3 Safe AI Provider & Gateway (`/assistant` & `/api/ai/receptionist`)
- [x] **Real Data Query**: AI เรียกเฉพาะเครื่องมือใน Allowlist (เช่น `list_services`, `check_availability`) และคืนเฉพาะรอบเวลาว่างจริงของช่าง
- [x] **Review & Confirmation Boundary**: ไม่อนุญาตให้โมเดลหรือผู้ใช้จองสำเร็จในทันที ต้องผ่านการตรวจสอบ Server Review และส่งคำยืนยัน `ยืนยัน` ในรอบถัดไปเท่านั้น
- [x] **Rate Limiting & Payload Limits**: มีการจำกัดขนาดข้อความไม่เกิน 2,000 ตัวอักษร และจำกัดความถี่ต่อ IP/Session ในระดับ PostgreSQL (`rate_limits`)
- [x] **Provider Degradation & Fallback**: รองรับการสลับไปมาระหว่าง `mock` และ `openai` โดยไม่กระทบต่อ Transaction และ Booking Core

### 1.4 Human Handoff Destination (`handoff_requests`)
- [x] **Policy Enforcement**: เมื่อลูกค้าขอส่วนลดพิเศษ (เช่น ขอส่วนลด 50%) ขอเวลาที่ไม่มี หรือร้องเรียน AI จะหยุดการจองและเข้าสู่สถานะ Handoff
- [x] **Escalation Notification**: แจ้งเบอร์โทรและช่องทางติดต่อของผู้จัดการร้านตามที่ระบุใน `HANDOFF_DESTINATION`
- [x] **Database Auditing**: มีการสร้างแถวข้อมูลสถานะ `pending` ลงในตาราง `handoff_requests` พร้อมเชื่อมโยง `session_id`
- [x] **Admin Resolution Flow**: ผู้ดูแลระบบสามารถดูรายการ Handoff ที่ค้างอยู่และกดรับเรื่อง/แก้ไขผ่าน `/admin` ได้

### 1.5 Automation Engine & Runner (`/api/internal/automation/run`)
- [x] **Secret Authorization**: ต้องส่ง `Authorization: Bearer <AUTOMATION_INTERNAL_SECRET>` หรือ Header `x-automation-secret` เท่านั้น (ปฏิเสธด้วย HTTP 403 Forbidden หากไม่มีหรือผิด)
- [x] **Job Idempotency**: ตรวจสอบ `event_key` ก่อนส่ง ทุก Job (Confirmation, Reminder, Follow-up) จะถูกประมวลผลและส่งเพียงครั้งเดียว
- [x] **No-Show Detection**: ตรวจจับการนัดหมายที่เลยเวลาเกิน Grace period (15 นาที) และเปลี่ยนสถานะเป็น `no_show` พร้อมบันทึก `booking_status_history` อัตโนมัติ
- [x] **Retry & Dead-Letter**: งานที่ส่งไม่สำเร็จจะถูกคำนวณ Exponential Backoff และเมื่อครบ Max Attempts (5 ครั้ง) จะถูกบันทึก `dead_lettered_at` เข้า Dead-Letter Queue โดยไม่ถูกลบออกจากระบบ

### 1.6 LINE Official Account Webhook (`/api/line/webhook`)
- [x] **Signature Verification**: ตรวจสอบ HMAC-SHA256 Signature (`x-line-signature`) กับ Raw Body เสมอ หากไม่ถูกต้องจะปฏิเสธด้วย HTTP 403 / Invalid Signature
- [x] **Safe Routing**: ข้อความจาก LINE จะถูกส่งต่อไปยัง AI Receptionist Service ผ่าน Safe Tool Gateway เช่นเดียวกับหน้าเว็บ
- [x] **Idempotent Webhook Events**: บันทึก `event_id` ลงในตาราง `line_webhook_events` เพื่อป้องกันการประมวลผลข้อความซ้ำจากการ Retry ของ LINE

---

## 2. ผลการรัน 8 Day-1 Smoke-Test Scenarios บน Staging

| Scenario | รายการทดสอบ | ขั้นตอนและ Endpoint | ผลการทดสอบบน Staging | สถานะ |
| :---: | :--- | :--- | :--- | :---: |
| **ST-01** | **Customer Web Booking** | `POST /api/bookings`<br>บริการ: ตัดผม (60 นาที)<br>ช่าง: ช่างแอน | - สร้าง Booking สำเร็จ<br>- สถานะเริ่มต้น: `confirmed`<br>- สร้าง Confirmation Job อัตโนมัติใน DB | **PASS** |
| **ST-02** | **Double-Booking Rejection** | `POST /api/bookings`<br>พยายามจองเวลาชนกับ ST-01 | - ถูกปฏิเสธทันทีด้วย HTTP 409 Conflict<br>- Database GiST constraint ป้องกันคิวซ้อน<br>- คืนข้อความภาษาไทยสุภาพ | **PASS** |
| **ST-03** | **Phone Verification Gate** | `GET /api/bookings/:id`<br>เปรียบเทียบระหว่างส่ง/ไม่ส่งเบอร์ | - ไม่ส่ง `x-booking-phone`: HTTP 403 Forbidden<br>- ส่งเบอร์ถูกต้อง: HTTP 200 OK แสดงข้อมูลนัดหมาย | **PASS** |
| **ST-04** | **Reschedule Flow** | `POST /api/bookings/:id/reschedule`<br>เปลี่ยนเวลานัดใหม่ของช่างแอน | - อัปเดตเวลานัดสำเร็จ<br>- ยกเลิก Reminder เดิม และสร้าง Reminder ของเวลาใหม่<br>- บันทึกประวัติลง `booking_status_history` | **PASS** |
| **ST-05** | **Cancellation Policy Gate** | `POST /api/bookings/:id/cancel`<br>ยกเลิกนัดหมายล่วงหน้า > 24 ชม. | - นัดหมายถูกเปลี่ยนเป็น `cancelled`<br>- ปลดปล่อยสล็อตเวลากลับมาว่างอีกครั้ง<br>- หากเหลือน้อยกว่า 24 ชม. ระบบจะปฏิเสธและให้ติดต่อร้าน | **PASS** |
| **ST-06** | **AI Receptionist Safe Booking** | `POST /api/ai/receptionist`<br>ค้นหาคิวตัดผม -> ตรวจสอบ Review -> ยืนยัน | - AI คืนเฉพาะสล็อตว่างจริง<br>- ไม่สร้าง Booking จนกว่าจะมีขั้นตอน Review<br>- จองสำเร็จเมื่อได้รับคำว่า `ยืนยัน` ในรอบถัดไป | **PASS** |
| **ST-07** | **Human Handoff Escalation** | `POST /api/ai/receptionist`<br>ข้อความ: "ขอลดราคา 50%" | - AI หยุดการจองและแจ้งเบอร์ติดต่อผู้จัดการร้าน<br>- สร้างแถวข้อมูลใน `handoff_requests` (สถานะ `pending`) | **PASS** |
| **ST-08** | **Admin & Automation Runner** | `POST /api/admin/session`<br>`POST /api/internal/automation/run` | - เข้าสู่ระบบ Admin สำเร็จและได้รับ Session Cookie<br>- Runner รันสำเร็จ ประมวลผล Confirmation Jobs ถูกต้อง | **PASS** |

---

## 3. การประเมินข้อติดขัด (Blocker Classification)

| ระดับความรุนแรง | รายการ | สถานะการตรวจสอบ | หมายเหตุ |
| :---: | :--- | :---: | :--- |
| **P0 (Blocker)** | ปัญหาที่ทำให้ระบบทำงานไม่ได้ หรือเสี่ยงต่อความปลอดภัย/ข้อมูลเสียหาย | **NONE** | ผ่านการทดสอบ PostgreSQL integration และ Exclusion constraint ครบถ้วน |
| **P1 (Critical)** | ปัญหาที่ต้องแก้ไขก่อนเปิดบริการแก่สาธารณะ | **NONE** | Health, Auth, Runner, Handoff ทำงานได้ตามข้อกำหนด |
| **P2 (Operational)** | ข้อควรปฏิบัติและข้อแนะนำด้านการดำเนินงาน | **INFORMATIONAL** | 1. ผู้จัดการร้านต้องมีโทรศัพท์สแตนด์บายรับสาย Handoff ในเวลาทำการ<br>2. ควรตั้งค่า Cron Job / Scheduler ให้ยิง Automation Runner ทุก 1-2 นาที สม่ำเสมอ |
