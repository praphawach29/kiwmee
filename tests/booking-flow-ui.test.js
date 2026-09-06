const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canContinue,
  conflictMessage,
  selectedStaffName
} = require("../src/ui/booking-flow");

test("customer booking progress only enables CTA when required data is complete", () => {
  const state = {
    service: { id: "service-1" },
    staffChoice: "any",
    staff: null,
    slot: { staff_id: "staff-1", start_at: "2026-09-10T13:00:00+07:00" },
    customer: { name: "A", phone: "0800000000" }
  };

  assert.equal(canContinue("service", { ...state, service: null }), false);
  assert.equal(canContinue("service", state), true);
  assert.equal(canContinue("staff", state), true);
  assert.equal(canContinue("time", { ...state, slot: null }), false);
  assert.equal(canContinue("time", state), true);
  assert.equal(canContinue("customer", { ...state, customer: { name: "A", phone: "" } }), false);
  assert.equal(canContinue("customer", state), true);
  assert.equal(canContinue("review", state), true);
});

test("customer flow maps backend conflict to customer-friendly Thai copy", () => {
  assert.equal(
    conflictMessage({ code: "CONFLICT", message: "requested slot is not available" }),
    "ช่วงเวลานี้เพิ่งถูกจอง กรุณาเลือกเวลาใหม่"
  );
});

test("any-staff booking uses the staff attached to the selected backend slot", () => {
  const state = {
    staffChoice: "any",
    staff: null,
    slot: { staff_id: "staff-ann" }
  };
  const staff = [
    { id: "staff-ann", name: "ช่างแอน" },
    { id: "staff-mean", name: "ช่างมีน" }
  ];

  assert.equal(selectedStaffName(state, staff), "ช่างแอน");
});
