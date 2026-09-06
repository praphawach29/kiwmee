# Automation Workflows

## 1. Booking Confirmation
Trigger: booking created
Condition: status=confirmed
Actions:
- create event_key `booking-confirmed:{booking_id}`
- send confirmation
- log result
- schedule reminder

## 2. Appointment Reminder
Trigger: N hours before start_at
Condition: confirmed
Actions:
- check event_key
- send reminder
- log

## 3. Cancellation
Trigger: booking cancelled
Actions:
- free slot naturally by status filter
- send cancellation message
- log history

## 4. Reschedule
Trigger: booking time changed
Actions:
- send new confirmation
- invalidate old reminder
- schedule new reminder

## 5. No-show Detection
Trigger: current time > start_at + grace period
Condition:
- status=confirmed
- no check-in
Actions:
- update no_show
- create history
- trigger follow-up

## 6. No-show Follow-up
Trigger: status=no_show
Actions:
- send polite follow-up
- offer reschedule

## 7. Post-service Follow-up
Trigger: status=completed + delay
Actions:
- thank customer
- request feedback
- offer next booking

## Idempotency
ทุก flow ต้องใช้ automation_logs.event_key เพื่อป้องกันยิงซ้ำ
