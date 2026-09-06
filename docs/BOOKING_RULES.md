# Booking Rules

## 1. Double Booking Prevention
ก่อนสร้าง booking:
1. ตรวจ staff active
2. ตรวจ staff ให้บริการนั้นได้
3. ตรวจ availability
4. ตรวจ existing booking ที่ status ไม่ใช่ cancelled/no_show/rescheduled
5. ถ้ามี overlap ให้ reject

Overlap condition:
new_start < existing_end AND new_end > existing_start

## 2. Duration
booking.end_at = booking.start_at + service.duration_minutes

## 3. Availability
Available Slot =
Staff Working Time
- Blocked Time
- Existing Active Bookings

## 4. Booking Confirmation
MVP:
- สร้างเป็น confirmed ได้เมื่อ slot valid
- ถ้าต้องการ manual approval ภายหลัง ค่อยใช้ pending

## 5. Cancellation
Default MVP policy:
- ลูกค้ายกเลิกได้ก่อนเวลานัดตามค่าที่ร้านกำหนด
- หากเลย policy window ให้ส่งต่อ staff

## 6. Reschedule
Reschedule ต้อง:
- ตรวจ slot ใหม่
- สร้าง history
- update booking time
- status เป็น rescheduled ชั่วคราวหรือ log event แล้วกลับ confirmed ตาม implementation choice

## 7. No-show
เมื่อเลยเวลานัด + grace period และยังไม่ checked_in:
- เปลี่ยน status → no_show
- บันทึก history
- trigger follow-up

## 8. Staff Block Time
Admin/Staff สามารถ block:
- พัก
- ลา
- งานภายใน
- ปิดร้านเฉพาะช่วง

## 9. Timezone
ใช้ Asia/Bangkok เป็น default
เก็บ timestamp ใน UTC ถ้า production

## 10. Idempotency
การ confirm/reminder/cancel automation ต้องไม่ยิงซ้ำ
ใช้ automation_logs ตรวจ event เดิมก่อนทำซ้ำ
