# API Contract

## GET /api/services
คืนบริการ active

## GET /api/staff?service_id=
คืน staff ที่ให้บริการนั้นได้

## GET /api/availability
Query:
- service_id
- staff_id (optional)
- date

Response:
```json
{
  "date":"2026-09-10",
  "slots":[
    {"staff_id":"...","start_at":"2026-09-10T10:00:00+07:00","end_at":"2026-09-10T11:00:00+07:00"}
  ]
}
```

## POST /api/bookings
```json
{
  "customer":{
    "name":"ลูกค้า A",
    "phone":"0800000000"
  },
  "service_id":"uuid",
  "staff_id":"uuid",
  "start_at":"2026-09-10T10:00:00+07:00",
  "source":"web"
}
```

Server must:
- fetch service duration
- calculate end_at
- validate staff/service
- validate availability
- check overlap inside transaction
- create customer if needed
- create booking
- create status history

## PATCH /api/bookings/:id/status
```json
{
  "status":"checked_in",
  "reason":"customer arrived"
}
```

## POST /api/bookings/:id/reschedule
```json
{
  "staff_id":"uuid",
  "start_at":"2026-09-11T14:00:00+07:00"
}
```

## POST /api/bookings/:id/cancel
```json
{"reason":"customer request"}
```

## GET /api/admin/bookings?date=
Admin daily schedule

## Phase 5 Access Boundary

GET `/api/bookings/:id`, POST reschedule and POST cancel now require
`x-booking-phone` matching the stored booking customer, or an authenticated admin cookie.
Customer cancellation ignores client-supplied actor/changed_by privileges and always applies
the customer cancellation policy. UUID alone is insufficient. Phone is sent in a header,
not the URL. The Manage Booking page asks for it before loading any appointment data.

GET admin bookings and PATCH booking status require a signed HttpOnly admin cookie.
POST `/api/admin/session` accepts `{ "password": "..." }`, verifies server ADMIN_PASSWORD
and sets the cookie. GET reports `{ data: { authenticated: true|false } }`.
Missing admin configuration fails closed; no default credential is embedded in the UI.

## POST /api/ai/receptionist

```json
{ "session_id": null, "message": "พรุ่งนี้ช่วงบ่ายมีคิวตัดผมไหม" }
```

Returns the standard `{ data }` envelope containing message, session_id, state, choices
and handoff. Session continuation requires both session_id and the HttpOnly ai_owner
cookie. State is a public projection of server state, never a client-authoritative draft.
Clients render only the returned choices/review/booking. Additional body fields are
rejected; maximum message length is 2000 characters and body size is 8192 bytes.

No raw tool execution endpoint is exposed. Tool definitions and validation live in
`src/ai/tools/catalog.js`. Mutations require a server review and an exact subsequent
customer confirmation; provider output alone cannot grant this capability.
