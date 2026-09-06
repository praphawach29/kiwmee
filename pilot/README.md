# Pilot #1 Configuration Pack — Luxe Hair & Beauty Studio

ชุดโครงสร้างการกำหนดค่าและคู่มือการเปิดใช้งานจริง (Configuration Pack & Launch Kit) สำหรับร้านเสริมสวยนำร่องแห่งแรกในระบบ **Salon Booking OS v1**

---

## สารบัญเอกสาร (Pack Structure)

| ไฟล์ / โฟลเดอร์ | หน้าที่และคำอธิบาย |
| :--- | :--- |
| [`pilot/PILOT_CONFIG_PROFILE.md`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/PILOT_CONFIG_PROFILE.md) | ข้อกำหนดทางธุรกิจ (Business Profile), แคตตาล็อกบริการจริง, รายชื่อช่าง, และนโยบายการจอง/ยกเลิก |
| [`pilot/.env.pilot.example`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/.env.pilot.example) | เทมเพลตตัวแปรสภาพแวดล้อมสำหรับ Production โดยไม่มีการใส่ Credentials จริง |
| [`pilot/database/pilot_salon_seed.sql`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/database/pilot_salon_seed.sql) | ข้อมูลเริ่มต้นของร้านจริง (บริการ 5 รายการ, ช่าง 3 ท่าน, กะเวลาทำงาน 14 วันล่วงหน้า) แยกจาก Demo seed เดิม |
| [`pilot/PREFLIGHT_CHECKS.md`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/PREFLIGHT_CHECKS.md) | เช็กลิสต์การตรวจความพร้อมของระบบและฐานข้อมูลก่อนปล่อยใช้งานจริง |
| [`pilot/LAUNCH_RUNBOOK.md`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/LAUNCH_RUNBOOK.md) | คู่มือการ Deploy และเปิดใช้งานทีละขั้นตอน (Step-by-Step Runbook) พร้อม Go/No-Go Gate |
| [`pilot/DAY1_SMOKE_TESTS.md`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/DAY1_SMOKE_TESTS.md) | 8 สถานการณ์ทดสอบหน้างานจริงในวันเปิดตัว (Day-1 Smoke Tests) |
| [`pilot/MONITORING_AND_EMERGENCY.md`](file:///c:/Users/Jack/Downloads/Salon_Booking_OS_v1_Starter_Kit/pilot/MONITORING_AND_EMERGENCY.md) | แผนการเฝ้าระวังระบบ, ตรวจสอบ Dead-letter queue และแผนฉุกเฉินรับมือเมื่อระบบภายนอกขัดข้อง |

---

## คำสั่งสำคัญสำหรับ Pilot #1

```bash
# 1. ตรวจสอบความถูกต้องของการตั้งค่าและฐานข้อมูล (Pre-flight)
npm run pilot:preflight

# 2. ตรวจสอบเฉพาะ Production Configuration
npm run config:check

# 3. สร้าง Password Hash สำหรับ Admin
ADMIN_PASSWORD_PLAIN='รหัสผ่านความยาว12ตัวขึ้นไป' npm run admin:hash-password

# 4. ทดสอบความถูกต้องของระบบทั้งหมด (Regression Test)
npm test

# 5. คอมไพล์โปรดักชัน
npm run build

# 6. สั่งรัน Automation Worker ด้วยตนเอง
npm run automation:run
```
