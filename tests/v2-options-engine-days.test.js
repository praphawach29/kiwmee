// Rentals over several days in the options engine (docs/FLEXIBLE_BOOKING_DESIGN.md 11.7): a car hire
// shop open 09:00–18:00, closed on Mondays, two cars, rented for 1–3 days of 24 hours each.
const test = require("node:test");
const assert = require("node:assert/strict");

const { getOptions, nextStep, REASONS } = require("../src/v2/options-engine");

const now = "2026-10-26T08:00:00+07:00"; // a Monday
const FRI = "2026-10-30";
const CAR1 = "c4000000-0000-4000-8000-000000000001";
const CAR2 = "c4000000-0000-4000-8000-000000000002";
const HIRE = "c5000000-0000-4000-8000-000000000001";

function cars() {
  return {
    business: { id: "b4000000-0000-4000-8000-000000000004", timezone: "Asia/Bangkok" },
    settings: { min_lead_minutes: 0, slot_interval_minutes: 60, max_advance_days: 30 },
    flow: { entry: ["offering"], require: ["offering", "date", "duration", "time"], optional: ["resource"], then: ["customer"], options: {} },
    hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_open: d !== 1, open_time: "09:00", close_time: "18:00" })),
    closures: [],
    resources: [
      { id: CAR1, kind: "car", name: "Yaris กข 1234", capacity: 1, sort_order: 1, active: true },
      { id: CAR2, kind: "car", name: "City กข 5678", capacity: 1, sort_order: 2, active: true }
    ],
    schedules: [],
    timeOff: [],
    offerings: [{ id: HIRE, category: null, name: "เช่ารถรายวัน", duration_mode: "days", min_days: 1, max_days: 3, buffer_after_minutes: 0, max_party_size: 1, sort_order: 1, active: true }],
    requirements: [{ offering_id: HIRE, kind: "car", customer_picks: true, units_per_booking: "one" }],
    offeringResources: [{ offering_id: HIRE, resource_id: CAR1 }, { offering_id: HIRE, resource_id: CAR2 }],
    busy: []
  };
}

const busy = (resource_id, start_at, end_at) => ({ resource_id, units: 1, start_at, end_at });
const base = { offeringId: HIRE, date: FRI };

test("the lengths are whole days; one that would come back on the closed Monday is greyed out", () => {
  const out = getOptions(cars(), { ask: "duration", selected: base, now }).options;
  assert.deepEqual(out.map((o) => [o.value, o.available, o.reason]), [
    [1440, true, null], // back Saturday
    [2880, true, null], // back Sunday
    [4320, false, REASONS.RETURN_CLOSED] // back Monday: closed
  ]);
});

test("pick-up times run through the opening hours; the return is the same time days later", () => {
  const out = getOptions(cars(), { ask: "time", selected: { ...base, durationMinutes: 2880 }, now }).options;
  assert.deepEqual(out.map((o) => o.value), ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
  assert.ok(out.every((o) => o.available));
});

test("a car out for part of the rental is not lent again; the other car still is", () => {
  const c = cars();
  c.busy = [busy(CAR1, "2026-10-31T10:00:00+07:00", "2026-11-01T10:00:00+07:00")]; // Saturday to Sunday
  const sel = { ...base, durationMinutes: 2880, time: "10:00" };
  const picks = getOptions(c, { ask: "resource", selected: sel, now }).options.filter((o) => o.value);
  assert.deepEqual(picks.map((o) => [o.value, o.available]), [[CAR1, false], [CAR2, true]]);

  c.busy.push(busy(CAR2, "2026-10-30T15:00:00+07:00", "2026-10-31T15:00:00+07:00"));
  const free = getOptions(c, { ask: "time", selected: { ...base, durationMinutes: 2880 }, now }).options.filter((o) => o.available).map((o) => o.value);
  assert.ok(!free.includes("10:00"), "both cars out at some point of Fri 10:00 → Sun 10:00");
  assert.deepEqual(free, [], "every pick-up time on Friday overlaps one car's hire or the other's");
});

test("a car marked off on any day of the rental cannot go; the closed Monday in the middle does not matter", () => {
  const c = cars();
  c.timeOff = [{ resource_id: CAR1, date: "2026-10-31", is_full_day: true }];
  const sel = { ...base, durationMinutes: 2880, time: "10:00" };
  const picks = getOptions(c, { ask: "resource", selected: sel, now }).options.filter((o) => o.value);
  assert.deepEqual(picks.map((o) => [o.value, o.available]), [[CAR1, false], [CAR2, true]]);

  // Sunday → Tuesday (2 days) passes the closed Monday: fine
  const sun = getOptions(cars(), { ask: "duration", selected: { ...base, date: "2026-11-01" }, now }).options;
  assert.deepEqual(sun.map((o) => [o.value, o.available]), [[1440, false], [2880, true], [4320, true]]);
});

test("the steps: offering → date → days → time → car → customer", () => {
  const c = cars();
  assert.equal(nextStep(c, { selected: { offeringId: HIRE }, now }).step, "date");
  assert.equal(nextStep(c, { selected: base, now }).step, "duration");
  assert.equal(nextStep(c, { selected: { ...base, durationMinutes: 1440 }, now }).step, "time");
  assert.equal(nextStep(c, { selected: { ...base, durationMinutes: 1440, time: "10:00" }, now }).step, "resource");
  // a shop flow that does not list the hours still asks for the days of a rental
  c.flow = { ...c.flow, require: ["offering", "date", "time"] };
  assert.equal(nextStep(c, { selected: base, now }).step, "duration");
});
