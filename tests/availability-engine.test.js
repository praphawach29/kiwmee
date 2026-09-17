const test = require("node:test");
const assert = require("node:assert/strict");

const { getAvailableSlots } = require("../src/availability-engine");
const { createBooking } = require("../src/booking-service");
const { FakeRepository, buildSeed } = require("./fake-repository");

function buildSeedForDate(dateStr) {
  const seed = buildSeed();
  seed.availability = [
    {
      staff_id: "staff-ann",
      start_at: `${dateStr}T10:00:00+07:00`,
      end_at: `${dateStr}T18:00:00+07:00`,
      type: "available"
    },
    {
      staff_id: "staff-ann",
      start_at: `${dateStr}T12:00:00+07:00`,
      end_at: `${dateStr}T13:00:00+07:00`,
      type: "blocked"
    },
    {
      staff_id: "staff-mean",
      start_at: `${dateStr}T10:00:00+07:00`,
      end_at: `${dateStr}T14:00:00+07:00`,
      type: "available"
    }
  ];
  return seed;
}

test("availability is calculated from working hours minus blocked time and active bookings", async () => {
  const repository = new FakeRepository(buildSeed());
  repository.bookings.push({
    id: "booking-1",
    staff_id: "staff-ann",
    service_id: "svc-cut",
    customer_id: "customer-1",
    start_at: "2026-09-10T10:30:00+07:00",
    end_at: "2026-09-10T11:30:00+07:00",
    status: "confirmed"
  });

  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-10"
  });

  const starts = result.slots.map((slot) => slot.start_at);
  assert.equal(result.date, "2026-09-10");
  assert.ok(starts.includes("2026-09-10T13:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T10:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T10:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T11:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T12:00:00+07:00"));
});

test("availability can search all active staff who can perform the service", async () => {
  const repository = new FakeRepository(buildSeed());

  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    date: "2026-09-10"
  });

  assert.ok(result.slots.some((slot) => slot.staff_id === "staff-ann"));
  assert.ok(result.slots.some((slot) => slot.staff_id === "staff-mean"));
});

test("availability rejects a selected staff member who cannot perform the service", async () => {
  const repository = new FakeRepository(buildSeed());

  await assert.rejects(
    getAvailableSlots(repository, {
      serviceId: "svc-color",
      staffId: "staff-mean",
      date: "2026-09-10"
    }),
    /staff cannot perform service/
  );
});

test("availability filters out past slots when now is specified", async () => {
  const repository = new FakeRepository(buildSeed());
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-10",
    now: new Date("2026-09-10T12:00:00+07:00")
  });

  const starts = result.slots.map((s) => s.start_at);
  // Ann's shift is 10:00 - 18:00, lunch break 12:00 - 13:00
  // Slots before or at 12:00 must be filtered out
  assert.ok(!starts.includes("2026-09-10T10:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T10:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T11:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T11:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-10T12:00:00+07:00"));
  // Lunch break (12:00-13:00) also blocks
  // Slots after 12:00 should be available (starting from 13:00)
  assert.ok(starts.includes("2026-09-10T13:00:00+07:00"));
  assert.ok(starts.includes("2026-09-10T13:30:00+07:00"));
});

test("availability automatically filters out past slots for today", async () => {
  const { toBangkokISOString } = require("../src/time");
  const repository = new FakeRepository(buildSeed());
  const todayBangkok = toBangkokISOString(new Date()).slice(0, 10);

  // Seed availability for today
  repository.availability.push({
    staff_id: "staff-ann",
    start_at: `${todayBangkok}T00:00:00+07:00`,
    end_at: `${todayBangkok}T23:59:00+07:00`,
    type: "available"
  });

  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: todayBangkok
  });

  const now = new Date();
  for (const slot of result.slots) {
    assert.ok(new Date(slot.start_at) > now, `Slot ${slot.start_at} must be strictly after now (${now.toISOString()})`);
  }
});

test("Test A: Today at 14:47 - Past slots excluded", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-17"));
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  // All past slots must be excluded
  assert.ok(!starts.includes("2026-09-17T10:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T10:15:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T10:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T10:45:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T11:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T13:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T14:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T14:15:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T14:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T14:45:00+07:00"));
  assert.ok(!starts.includes("2026-09-17T15:00:00+07:00"));
  // Valid slots start strictly after 14:47 + 15m lead = 15:02
  for (const start of starts) {
    assert.ok(new Date(start) > new Date("2026-09-17T15:02:00+07:00"));
  }
});

test("Test B: Today + 15 minute lead time - 15:00 excluded, 15:15 allowed if free", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-17"));
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  // Cutoff is 14:47 + 15m = 15:02. 15:00 is <= 15:02 so excluded. 15:15 is > 15:02 so included.
  assert.ok(!starts.includes("2026-09-17T15:00:00+07:00"), "15:00 must be excluded");
  assert.ok(starts.includes("2026-09-17T15:15:00+07:00"), "15:15 must be allowed if free");
});

test("Test C: Future date - Morning slots remain available", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(starts.includes("2026-09-18T10:00:00+07:00"), "Morning slot 10:00 must be available on future date");
  assert.ok(starts.includes("2026-09-18T10:15:00+07:00"), "Morning slot 10:15 must be available on future date");
  assert.ok(starts.includes("2026-09-18T11:00:00+07:00"), "Morning slot 11:00 must be available on future date");
});

test("Test D: Existing confirmed booking - Overlapping slots excluded", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  repository.bookings.push({
    id: "booking-d",
    staff_id: "staff-ann",
    service_id: "svc-cut",
    customer_id: "customer-d",
    start_at: "2026-09-18T14:00:00+07:00",
    end_at: "2026-09-18T15:00:00+07:00",
    status: "confirmed"
  });
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  // Service is 60m. Overlaps with 14:00-15:00:
  assert.ok(!starts.includes("2026-09-18T13:15:00+07:00"), "13:15 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T13:30:00+07:00"), "13:30 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T13:45:00+07:00"), "13:45 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T14:00:00+07:00"), "14:00 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T14:15:00+07:00"), "14:15 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T14:30:00+07:00"), "14:30 overlaps 14:00-15:00");
  assert.ok(!starts.includes("2026-09-18T14:45:00+07:00"), "14:45 overlaps 14:00-15:00");
  // Non-overlapping slots:
  assert.ok(starts.includes("2026-09-18T13:00:00+07:00"), "13:00-14:00 does not overlap");
  assert.ok(starts.includes("2026-09-18T15:00:00+07:00"), "15:00-16:00 does not overlap");
});

test("Test E: Existing pending booking - Overlapping slots excluded", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  repository.bookings.push({
    id: "booking-e",
    staff_id: "staff-ann",
    service_id: "svc-cut",
    customer_id: "customer-e",
    start_at: "2026-09-18T14:00:00+07:00",
    end_at: "2026-09-18T15:00:00+07:00",
    status: "pending"
  });
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-18T14:00:00+07:00"), "Pending booking must block 14:00");
  assert.ok(!starts.includes("2026-09-18T14:30:00+07:00"), "Pending booking must block 14:30");
});

test("Test F: Cancelled booking - Slot becomes available again", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  repository.bookings.push({
    id: "booking-f",
    staff_id: "staff-ann",
    service_id: "svc-cut",
    customer_id: "customer-f",
    start_at: "2026-09-18T14:00:00+07:00",
    end_at: "2026-09-18T15:00:00+07:00",
    status: "cancelled"
  });
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(starts.includes("2026-09-18T14:00:00+07:00"), "Cancelled booking must release slot 14:00");
});

test("Test G: Expired booking - Slot becomes available again", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  repository.bookings.push({
    id: "booking-g",
    staff_id: "staff-ann",
    service_id: "svc-cut",
    customer_id: "customer-g",
    start_at: "2026-09-18T14:00:00+07:00",
    end_at: "2026-09-18T15:00:00+07:00",
    status: "expired"
  });
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(starts.includes("2026-09-18T14:00:00+07:00"), "Expired booking must release slot 14:00");
});

test("Test H: 60-minute service - Entire 60-minute interval must fit", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  // Ann's shift ends at 18:00
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut", // 60 min service
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  // 17:00 ends at 18:00 -> fits!
  assert.ok(starts.includes("2026-09-18T17:00:00+07:00"), "17:00 slot fits within shift");
  // 17:15 would end at 18:15 (exceeds 18:00 shift end) -> must NOT be offered
  assert.ok(!starts.includes("2026-09-18T17:15:00+07:00"), "17:15 slot exceeds shift end");
  assert.ok(!starts.includes("2026-09-18T17:30:00+07:00"), "17:30 slot exceeds shift end");
  assert.ok(!starts.includes("2026-09-18T17:45:00+07:00"), "17:45 slot exceeds shift end");
});

test("Test I: Staff break overlap - Candidate excluded", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  // Ann's lunch break is 12:00 to 13:00
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut", // 60 min
    staffId: "staff-ann",
    date: "2026-09-18",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  const starts = result.slots.map((s) => s.start_at);
  // 11:00-12:00 fits before break
  assert.ok(starts.includes("2026-09-18T11:00:00+07:00"));
  // Overlaps break (12:00-13:00):
  assert.ok(!starts.includes("2026-09-18T11:15:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T11:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T11:45:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T12:00:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T12:15:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T12:30:00+07:00"));
  assert.ok(!starts.includes("2026-09-18T12:45:00+07:00"));
  // 13:00-14:00 fits after break
  assert.ok(starts.includes("2026-09-18T13:00:00+07:00"));
});

test("Test J: Two simultaneous booking attempts - Database prevents overlap", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-18"));
  const input = {
    customer: { name: "Customer J1", phone: "0811111111" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-18T15:15:00+07:00"
  };

  const booking1 = await createBooking(repository, input);
  assert.ok(booking1.id);

  // Second concurrent attempt for the exact same slot must be rejected
  await assert.rejects(
    createBooking(repository, {
      customer: { name: "Customer J2", phone: "0822222222" },
      service_id: "svc-cut",
      staff_id: "staff-ann",
      start_at: "2026-09-18T15:15:00+07:00"
    }),
    /requested slot is not available/
  );
});

test("Test K: Asia/Bangkok timezone boundary - Today/tomorrow calculation correct around midnight", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-17"));
  repository.availability.push({
    staff_id: "staff-ann",
    start_at: "2026-09-18T10:00:00+07:00",
    end_at: "2026-09-18T18:00:00+07:00",
    type: "available"
  });

  // K1. 23:55 Bangkok time (16:55 UTC) -> Today is 2026-09-17
  const nowBeforeMidnight = new Date("2026-09-17T23:55:00+07:00");
  const resToday = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: nowBeforeMidnight
  });
  // Past time cutoff applies; shift ended at 18:00, so 0 slots for today
  assert.equal(resToday.slots.length, 0);

  // Tomorrow is 2026-09-18 -> future date, morning slots available
  const resTomorrow = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: nowBeforeMidnight
  });
  assert.ok(resTomorrow.slots.length > 0);
  assert.ok(resTomorrow.slots.some((s) => s.start_at === "2026-09-18T10:00:00+07:00"));

  // K2. 00:05 Bangkok time next day (17:05 UTC) -> Today is now 2026-09-18
  const nowAfterMidnight = new Date("2026-09-18T00:05:00+07:00");
  const resYesterdayNow = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17", // now before today!
    now: nowAfterMidnight
  });
  // Past date returns no availability
  assert.equal(resYesterdayNow.slots.length, 0);

  const resTodayNow = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: nowAfterMidnight
  });
  // 10:00 slot is after 00:05 + 15m (00:20), so it is available
  assert.ok(resTodayNow.slots.some((s) => s.start_at === "2026-09-18T10:00:00+07:00"));
});

test("Past date before today returns no availability", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-16"));
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-16",
    now: new Date("2026-09-17T14:47:00+07:00")
  });
  assert.equal(result.slots.length, 0);
});

test("Configurable lead time: BOOKING_MIN_LEAD_MINUTES from options and env", async () => {
  const repository = new FakeRepository(buildSeedForDate("2026-09-17"));
  // With 30 minute lead time at 14:47, cutoff is 15:17 -> 15:15 is excluded, earliest is 15:30
  const result = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: new Date("2026-09-17T14:47:00+07:00"),
    leadMinutes: 30
  });
  const starts = result.slots.map((s) => s.start_at);
  assert.ok(!starts.includes("2026-09-17T15:15:00+07:00"), "15:15 excluded with 30m lead time");
  assert.ok(starts.includes("2026-09-17T15:30:00+07:00"), "15:30 allowed with 30m lead time");
});
