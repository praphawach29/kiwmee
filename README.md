# Salon Booking OS v1 — Project Starter Kit

ระบบจองสำหรับร้านเสริมสวย/Beauty ที่สร้างต่อจาก AI Business System Factory Booking Intelligence v0.4.1

## เป้าหมาย
สร้าง MVP ที่ใช้งานได้จริงสำหรับ:
- ลูกค้าจองบริการ
- เลือกพนักงาน/เวลา
- กันเวลาชน
- ยืนยัน/เปลี่ยน/ยกเลิกนัด
- Reminder
- No-show follow-up
- Customer history
- AI Receptionist
- Dashboard ร้าน

## Recommended Stack
Frontend: Next.js / React
Backend: Node / Next API
Database: PostgreSQL / Supabase
Automation: n8n หรือ Make
Messaging: LINE OA / Email / SMS ตามช่องทางที่ร้านใช้

## Build Order
1. Database
2. Availability engine
3. Booking API
4. Booking UI
5. Admin dashboard
6. Automation
7. AI Receptionist
8. Pilot test

## Current Phase

Phase 1-6 are implemented. The browser experience is available at:

- `/` customer booking
- `/assistant` AI Receptionist pilot (Mock provider by default, OpenAI provider configurable)
- `/manage` verified booking management
- `/admin` password-protected minimal admin

Apply `database/migrations/004_automation_jobs.sql` and
`database/migrations/005_automation_retry.sql` when upgrading an existing Phase 3 database.
Apply `database/migrations/006_pilot_hardening.sql` when upgrading an existing Phase 5
database. See `automation/PHASE_4_IMPLEMENTATION.md`, `ai/PHASE_5_IMPLEMENTATION.md`,
`ai/PHASE_6_IMPLEMENTATION.md`, and `docs/PILOT_DEPLOYMENT.md` for local configuration,
verification commands and pilot limitations.

## Source of Truth
อ่านตามลำดับ:
1. docs/PRD.md
2. docs/BOOKING_RULES.md
3. database/schema.sql
4. api/API_CONTRACT.md
5. ui/SCREEN_SPEC.md
6. automation/AUTOMATION_WORKFLOWS.md
7. ai/AI_RECEPTIONIST_PROMPT.md
8. docs/DEVELOPER_BUILD_INSTRUCTIONS.md
