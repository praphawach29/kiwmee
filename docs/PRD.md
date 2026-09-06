# Product Requirements Document — Salon Booking OS v1

## Product Goal
ช่วยร้าน Beauty ลดเวลารับนัด ลดการนัดชน ลด no-show และรวมข้อมูลลูกค้าไว้ในระบบเดียว

## Primary Users
### Customer
- ดูบริการ
- เลือกวัน/เวลา
- เลือกพนักงาน (ถ้าต้องการ)
- จอง
- ดูสถานะ
- เปลี่ยน/ยกเลิกตาม policy

### Staff
- ดูตารางงาน
- ดู booking ของตัวเอง
- check-in / complete
- block time

### Owner/Admin
- จัดการบริการ
- จัดการพนักงาน
- ตั้งเวลาทำงาน
- ดู booking ทั้งหมด
- override booking เมื่อจำเป็น
- ดู dashboard

### AI Receptionist
- ตอบ FAQ
- แนะนำบริการจาก knowledge
- ช่วยค้น slot
- เก็บข้อมูลลูกค้า
- ช่วยสร้าง booking request
- ช่วย reschedule/cancel ตาม policy
- handoff ให้คนเมื่อเกินสิทธิ์

## MVP Modules
1. Service Catalog
2. Staff
3. Staff-Service Mapping
4. Availability
5. Booking
6. Booking Status History
7. Customer CRM
8. Reminder Automation
9. No-show Automation
10. AI Receptionist
11. Admin Dashboard

## Booking Status
- pending
- confirmed
- checked_in
- completed
- cancelled
- no_show
- rescheduled

## MVP Success Criteria
- ห้ามมี double booking
- ลูกค้าจองได้ภายใน 2–3 นาที
- ร้านเห็น booking วันนี้ได้
- reminder ทำงาน
- status history ถูกบันทึก
- AI ไม่เดา availability
- save/reopen booking ได้
