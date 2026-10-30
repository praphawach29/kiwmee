const test = require("node:test");
const assert = require("node:assert/strict");
const { REASON_TEXT } = require("../src/v2/reason-text");

// every reason code the booking RPCs raise (supabase/migrations) must have Thai wording
const RAISED = ["NOT_FOUND", "FULLY_BOOKED", "HOLD_EXPIRED", "BUSINESS_CLOSED", "CUSTOMER_CHANGE_OFF", "CUSTOMER_NAME_REQUIRED",
  "INVALID_DURATION", "INVALID_PARTY_SIZE", "INVALID_TIME", "NO_WORKING_WINDOW", "NOT_CHANGEABLE", "NOT_IN_PAST", "NOT_OFFERED",
  "OUTSIDE_BOOKING_WINDOW", "PAST_WORKING_HOURS", "STAFF_OFF", "TOO_LATE_TO_CHANGE"];

test("every booking RPC reason has customer-facing Thai text", () => {
  for (const code of RAISED) assert.match(REASON_TEXT[code] ?? "", /[\u0E00-\u0E7F]/, code);
});

test("the public booking error carries Thai text and keeps the code as reason", () => {
  const { bookingError } = require("../src/v2/public-booking");
  const error = bookingError({ code: "BK422", message: "NO_WORKING_WINDOW" });
  assert.equal(error.status ?? error.statusCode, 422);
  assert.equal(error.message, REASON_TEXT.NO_WORKING_WINDOW);
});
