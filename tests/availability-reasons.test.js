// Tests for Phase A1: Zero Availability Reasons, Business Schedules, and Admin Settings
const test = require("node:test");
const assert = require("node:assert/strict");

const { getAvailableSlots, ZERO_AVAILABILITY_REASONS } = require("../src/availability-engine");
const { FakeRepository, buildSeed } = require("./fake-repository");
const { setRepository } = require("../src/repositories");
const { adminToken } = require("../src/security/access");
const { getZeroSlotMessage, buildZeroSlotChoices } = require("../src/ai/receptionist");

process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "phase_a1_test_secret_32_characters_long!";

function createBaseRepo(dateStr = "2026-09-17") {
  const seed = buildSeed();
  seed.availability = [
    {
      staff_id: "staff-ann",
      start_at: `${dateStr}T10:00:00+07:00`,
      end_at: `${dateStr}T19:00:00+07:00`,
      type: "available"
    },
    {
      staff_id: "staff-mean",
      start_at: `${dateStr}T10:00:00+07:00`,
      end_at: `${dateStr}T19:00:00+07:00`,
      type: "available"
    }
  ];
  const repo = new FakeRepository(seed);
  // Default business hours 10:00 - 19:00 for all 7 days
  repo.businessHours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    id: `bh-${day}`,
    business_id: "default",
    day_of_week: day,
    is_open: true,
    open_time: "10:00",
    close_time: "19:00"
  }));
  return repo;
}

test("Test A: Today after closing -> PAST_WORKING_HOURS", async () => {
  const repo = createBaseRepo("2026-09-17");
  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: "2026-09-17T19:30:00+07:00" // 19:30 is past closing time 19:00
  });

  assert.equal(result.date, "2026-09-17");
  assert.equal(result.slots.length, 0);
  assert.equal(result.availability_status, "unavailable");
  assert.equal(result.reason, ZERO_AVAILABILITY_REASONS.PAST_WORKING_HOURS);
});

test("Test B: Store holiday -> BUSINESS_CLOSED", async () => {
  const repo = createBaseRepo("2026-09-20");
  // Set holiday closure for 2026-09-20
  repo.businessClosures.push({
    id: "closure-1",
    business_id: "default",
    closure_date: "2026-09-20",
    is_all_day: true,
    reason: "Songkran Holiday"
  });

  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-20",
    now: "2026-09-17T10:00:00+07:00"
  });

  assert.equal(result.date, "2026-09-20");
  assert.equal(result.slots.length, 0);
  assert.equal(result.availability_status, "unavailable");
  assert.equal(result.reason, ZERO_AVAILABILITY_REASONS.BUSINESS_CLOSED);
});

test("Test C: Staff day off -> STAFF_OFF", async () => {
  const repo = createBaseRepo("2026-09-17"); // 2026-09-17 is Thursday (day_of_week = 4)
  // Set staff-ann schedule: day 4 is off
  repo.staffSchedules = [
    {
      id: "ss-4",
      business_id: "default",
      staff_id: "staff-ann",
      day_of_week: 4,
      is_working: false,
      start_time: "10:00",
      end_time: "19:00"
    }
  ];

  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: "2026-09-17T09:00:00+07:00"
  });

  assert.equal(result.date, "2026-09-17");
  assert.equal(result.slots.length, 0);
  assert.equal(result.availability_status, "unavailable");
  assert.equal(result.reason, ZERO_AVAILABILITY_REASONS.STAFF_OFF);
});

test("Test D: Store open but all slots booked -> FULLY_BOOKED", async () => {
  const repo = createBaseRepo("2026-09-18");
  // Fill all slots for staff-ann from 10:00 to 19:00 with 60-minute bookings
  const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18];
  for (let i = 0; i < hours.length; i++) {
    const h = String(hours[i]).padStart(2, "0");
    const nextH = String(hours[i] + 1).padStart(2, "0");
    repo.bookings.push({
      id: `booking-fill-${i}`,
      staff_id: "staff-ann",
      service_id: "svc-cut",
      customer_id: `cust-${i}`,
      start_at: `2026-09-18T${h}:00:00+07:00`,
      end_at: `2026-09-18T${nextH}:00:00+07:00`,
      status: "confirmed"
    });
  }

  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: "2026-09-17T10:00:00+07:00"
  });

  assert.equal(result.date, "2026-09-18");
  assert.equal(result.slots.length, 0);
  assert.equal(result.availability_status, "unavailable");
  assert.equal(result.reason, ZERO_AVAILABILITY_REASONS.FULLY_BOOKED);
});

test("Test E: Tomorrow open -> availability_status = available, reason = null", async () => {
  const repo = createBaseRepo("2026-09-18");
  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: "2026-09-17T10:00:00+07:00"
  });

  assert.equal(result.date, "2026-09-18");
  assert.ok(result.slots.length > 0);
  assert.equal(result.availability_status, "available");
  assert.equal(result.reason, null);
});

test("Test F: Partial closure 13:00-15:00 -> overlapping slots excluded", async () => {
  const repo = createBaseRepo("2026-09-18");
  // Partial closure from 13:00 to 15:00
  repo.businessClosures.push({
    id: "partial-1",
    business_id: "default",
    closure_date: "2026-09-18",
    is_all_day: false,
    start_time: "13:00",
    end_time: "15:00",
    reason: "Deep Cleaning"
  });

  const result = await getAvailableSlots(repo, {
    serviceId: "svc-cut", // 60 min service
    staffId: "staff-ann",
    date: "2026-09-18",
    now: "2026-09-17T10:00:00+07:00"
  });

  assert.ok(result.slots.length > 0);
  const startTimes = result.slots.map((s) => s.start_at);
  // Slot at 12:15 would end at 13:15 (overlaps 13:00-15:00) -> excluded
  assert.ok(!startTimes.includes("2026-09-18T13:00:00+07:00"));
  assert.ok(!startTimes.includes("2026-09-18T13:30:00+07:00"));
  assert.ok(!startTimes.includes("2026-09-18T14:00:00+07:00"));
  // 10:00 and 15:00 should be available
  assert.ok(startTimes.includes("2026-09-18T10:00:00+07:00"));
  assert.ok(startTimes.includes("2026-09-18T15:00:00+07:00"));
});

test("Test G: Staff time off -> only affected staff excluded", async () => {
  const repo = createBaseRepo("2026-09-18");
  // Ann is on leave all day
  repo.staffTimeOff.push({
    id: "to-ann",
    business_id: "default",
    staff_id: "staff-ann",
    start_date: "2026-09-18",
    end_date: "2026-09-18",
    is_all_day: true,
    reason: "Personal Leave"
  });

  // Querying Ann specifically -> unavailable (STAFF_OFF)
  const annResult = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-18",
    now: "2026-09-17T10:00:00+07:00"
  });
  assert.equal(annResult.slots.length, 0);
  assert.equal(annResult.reason, ZERO_AVAILABILITY_REASONS.STAFF_OFF);

  // Querying without specific staff -> Mean is still available!
  const anyResult = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    date: "2026-09-18",
    now: "2026-09-17T10:00:00+07:00"
  });
  assert.ok(anyResult.slots.length > 0);
  assert.equal(anyResult.availability_status, "available");
  assert.equal(anyResult.reason, null);
  // All slots belong to staff-mean
  assert.ok(anyResult.slots.every((s) => s.staff_id === "staff-mean"));
});

test("Test H: Non-pilot tenant cannot modify settings (tenant isolation)", async () => {
  const repo = createBaseRepo();
  setRepository(repo);
  const { setPilotRepository } = require("../src/repositories/pilot");
  setPilotRepository({ isAdminSessionRevoked: async () => false });

  const { PUT: hoursPut } = require("../app/api/admin/settings/hours/route");
  const { PUT: bookingPut } = require("../app/api/admin/settings/booking/route");

  const token = adminToken();

  // Try updating hours with non-pilot tenant header
  const reqHours = new Request("http://localhost/api/admin/settings/hours", {
    method: "PUT",
    headers: {
      cookie: `salon_admin=${token}`,
      "x-business-id": "tenant-xyz",
      "content-type": "application/json"
    },
    body: JSON.stringify({ hours: [] })
  });
  const resHours = await hoursPut(reqHours);
  assert.equal(resHours.status, 403);

  // Try updating booking settings with non-pilot tenant header
  const reqBooking = new Request("http://localhost/api/admin/settings/booking", {
    method: "PUT",
    headers: {
      cookie: `salon_admin=${token}`,
      "x-business-id": "tenant-xyz",
      "content-type": "application/json"
    },
    body: JSON.stringify({ lead_time_minutes: 30 })
  });
  const resBooking = await bookingPut(reqBooking);
  assert.equal(resBooking.status, 403);
});

test("Test I: LINE receptionist message maps each reason correctly with action buttons", () => {
  // Check copy
  assert.ok(getZeroSlotMessage("PAST_WORKING_HOURS").includes("หมดช่วงเวลา"));
  assert.ok(getZeroSlotMessage("BUSINESS_CLOSED").includes("ร้านหยุดให้บริการ"));
  assert.ok(getZeroSlotMessage("STAFF_OFF").includes("ช่างคนนี้ไม่เข้าร้าน"));
  assert.ok(getZeroSlotMessage("FULLY_BOOKED").includes("คิวเต็ม"));

  // Check choices
  const sessionWithoutStaff = { selectedDate: "2026-09-17" };
  const choices1 = buildZeroSlotChoices(sessionWithoutStaff, "FULLY_BOOKED");
  assert.ok(choices1.some((c) => c.label === "พรุ่งนี้"));
  assert.ok(choices1.some((c) => c.label === "เลือกวันที่อื่น"));
  assert.ok(!choices1.some((c) => c.label === "เปลี่ยนช่าง"));

  const sessionWithStaff = { selectedDate: "2026-09-17", staffId: "staff-ann" };
  const choices2 = buildZeroSlotChoices(sessionWithStaff, "STAFF_OFF");
  assert.ok(choices2.some((c) => c.label === "พรุ่งนี้"));
  assert.ok(choices2.some((c) => c.label === "เลือกวันที่อื่น"));
  assert.ok(choices2.some((c) => c.label === "เปลี่ยนช่าง"));
});

test("Test J: Settings precedence: options > business settings > safe system defaults", async () => {
  const repo = createBaseRepo("2026-09-17");
  // Set business booking settings: lead_time = 45 min
  repo.businessBookingSettings = [
    {
      id: "bbs-1",
      business_id: "default",
      lead_time_minutes: 45,
      slot_interval_minutes: 15,
      max_advance_days: 60
    }
  ];

  // Now = 10:00. With 45 min lead time, slot at 10:15, 10:30, 10:45 excluded; first available >= 10:45
  const resFromSettings = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: "2026-09-17T10:00:00+07:00"
  });
  const startsSettings = resFromSettings.slots.map((s) => s.start_at);
  assert.ok(!startsSettings.includes("2026-09-17T10:15:00+07:00"));
  assert.ok(!startsSettings.includes("2026-09-17T10:30:00+07:00"));
  assert.ok(!startsSettings.includes("2026-09-17T10:45:00+07:00"));
  assert.ok(startsSettings.includes("2026-09-17T11:00:00+07:00"));

  // Explicit option overrides business settings (e.g. lead_time_minutes = 15)
  const resFromOption = await getAvailableSlots(repo, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-17",
    now: "2026-09-17T10:00:00+07:00",
    leadTimeMinutes: 15
  });
  const startsOption = resFromOption.slots.map((s) => s.start_at);
  assert.ok(!startsOption.includes("2026-09-17T10:15:00+07:00"));
  assert.ok(startsOption.includes("2026-09-17T10:30:00+07:00"));
});
