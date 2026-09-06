const test = require("node:test");
const assert = require("node:assert/strict");

const { getAvailableSlots } = require("../src/availability-engine");
const { FakeRepository, buildSeed } = require("./fake-repository");

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
