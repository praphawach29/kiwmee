const test = require("node:test");
const assert = require("node:assert/strict");

const { cancelBooking, createBooking, rescheduleBooking } = require("../src/booking-service");
const { getAvailableSlots } = require("../src/availability-engine");
const { FakeRepository, HistoryFailingRepository, buildSeed } = require("./fake-repository");

test("createBooking runs in a transaction, calculates duration, reuses customer, and writes history", async () => {
  const repository = new FakeRepository({
    ...buildSeed(),
    customers: [{ id: "customer-1", name: "A", phone: "0800000000" }]
  });

  const booking = await createBooking(repository, {
    customer: { name: "A", phone: "0800000000" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00",
    source: "web"
  });

  assert.equal(repository.transactionCount, 1);
  assert.equal(repository.lockedStaffId, "staff-ann");
  assert.equal(booking.customer_id, "customer-1");
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.end_at, "2026-09-10T07:00:00.000Z");
  assert.equal(repository.bookingStatusHistory.length, 1);
});

test("createBooking rejects a double booking before insert", async () => {
  const repository = new FakeRepository(buildSeed());
  await createBooking(repository, {
    customer: { name: "A", phone: "0800000000" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00"
  });

  await assert.rejects(
    createBooking(repository, {
      customer: { name: "B", phone: "0800000001" },
      service_id: "svc-cut",
      staff_id: "staff-ann",
      start_at: "2026-09-10T13:30:00+07:00"
    }),
    /requested slot is not available/
  );
});

test("rescheduleBooking runs in a transaction and excludes the booking being moved", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await createBooking(repository, {
    customer: { name: "A", phone: "0800000000" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00"
  });

  const updated = await rescheduleBooking(repository, booking.id, {
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00",
    reason: "customer request"
  });

  assert.equal(repository.transactionCount, 2);
  assert.equal(updated.start_at, "2026-09-10T07:00:00.000Z");
  assert.equal(updated.end_at, "2026-09-10T08:00:00.000Z");
  assert.equal(updated.status, "confirmed");
  assert.equal(repository.bookingStatusHistory.length, 2);
});

test("rescheduleBooking rejects conflicts with another active booking", async () => {
  const repository = new FakeRepository(buildSeed());
  const first = await createBooking(repository, {
    customer: { name: "A", phone: "0800000000" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00"
  });
  await createBooking(repository, {
    customer: { name: "B", phone: "0800000001" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  });

  await assert.rejects(
    rescheduleBooking(repository, first.id, {
      staff_id: "staff-ann",
      start_at: "2026-09-10T14:30:00+07:00"
    }),
    /requested slot is not available/
  );
});

test("cancelBooking changes status so the slot becomes available again", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await createBooking(repository, {
    customer: { name: "A", phone: "0800000000" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00"
  });

  await cancelBooking(repository, booking.id, {
    actor: "customer",
    now: "2026-09-09T12:00:00+07:00",
    reason: "customer request"
  });

  const availability = await getAvailableSlots(repository, {
    serviceId: "svc-cut",
    staffId: "staff-ann",
    date: "2026-09-10"
  });

  assert.ok(availability.slots.some((slot) => slot.start_at === "2026-09-10T13:00:00+07:00"));
});

test("createBooking rolls back customer and booking if history insert fails", async () => {
  const repository = new HistoryFailingRepository(buildSeed());

  await assert.rejects(
    createBooking(repository, {
      customer: { name: "A", phone: "0800000000" },
      service_id: "svc-cut",
      staff_id: "staff-ann",
      start_at: "2026-09-10T13:00:00+07:00"
    }),
    /forced history failure/
  );

  assert.equal(repository.customers.length, 0);
  assert.equal(repository.bookings.length, 0);
  assert.equal(repository.bookingStatusHistory.length, 0);
});
