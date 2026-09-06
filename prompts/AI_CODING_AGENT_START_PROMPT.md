# Prompt สำหรับ AI Coding Agent

อ่านไฟล์ต่อไปนี้ก่อนเริ่มเขียนโค้ด:
1. README.md
2. docs/PRD.md
3. docs/BOOKING_RULES.md
4. database/schema.sql
5. api/API_CONTRACT.md
6. ui/SCREEN_SPEC.md
7. automation/AUTOMATION_WORKFLOWS.md
8. ai/AI_RECEPTIONIST_PROMPT.md
9. docs/DEVELOPER_BUILD_INSTRUCTIONS.md

เป้าหมาย:
สร้าง Salon Booking OS v1 แบบ MVP

ข้อกำหนด:
- ห้ามเปลี่ยน booking rules โดยพลการ
- ต้องป้องกัน double booking
- ใช้ transaction ตอนสร้าง/reschedule booking
- ห้ามเก็บ secret ใน frontend
- availability ต้องคำนวณจาก database จริง
- AI Receptionist ห้ามเดา slot
- ให้สร้างทีละ phase และทดสอบแต่ละ phase ก่อนทำต่อ

เริ่มจาก:
Phase 1 Database + Phase 2 Availability Engine

เมื่อเสร็จให้รายงาน:
- ไฟล์ที่สร้าง/แก้
- API ที่เพิ่ม
- test ที่ผ่าน
- issue ที่ยังเหลือ
