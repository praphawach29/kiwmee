# Developer Build Instructions

## Phase 1 — Database
- Run database/schema.sql
- Run seed data
- Verify FK
- Verify indexes

## Phase 2 — Availability Engine
Implement:
- service duration
- staff-service validation
- working/blocked windows
- existing booking overlap

Function:
`getAvailableSlots(serviceId, staffId, date)`

## Phase 3 — Booking Transaction
Booking creation must run transaction:
1. load service
2. calculate end
3. re-check availability
4. check overlap
5. create/reuse customer
6. insert booking
7. insert history
8. commit

## Phase 4 — Customer UI
Build:
Service → Staff → Date/Time → Customer info → Review → Success

## Phase 5 — Admin
Build daily schedule and booking detail first

## Phase 6 — Automation
Add confirmation + reminder before no-show flows

## Phase 7 — AI Receptionist
AI must call availability API, never infer open slots

## MVP Done Definition
- create booking
- reject conflict
- reschedule
- cancel
- check-in
- complete
- no-show
- reminder
- save history
- dashboard
- AI receptionist handoff
