const test = require("node:test");
const assert = require("node:assert/strict");

const {
  JOB_TYPES,
  detectNoShows,
  handleBookingCancelled,
  handleBookingCompleted,
  handleBookingCreated,
  handleBookingRescheduled,
  processDueAutomationJobs,
  reconcileAutomationJobs,
  runAutomationCycle
} = require("../src/automation/automation-service");
const { MockNotificationProvider } = require("../src/automation/providers");
const { createBooking } = require("../src/booking-service");
const { FakeRepository, buildSeed } = require("./fake-repository");

const config = {
  reminderHoursBefore: 24,
  noShowGraceMinutes: 15,
  noShowFollowupHours: 1,
  postServiceFollowupHours: 24
};

test("booking confirmation and reminder jobs are created once", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");

  await handleBookingCreated(repository, booking, config);
  await handleBookingCreated(repository, booking, config);

  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.filter((job) => job.automation_type === JOB_TYPES.confirmation).length, 1);
  assert.equal(jobs.filter((job) => job.automation_type === JOB_TYPES.reminder).length, 1);
});

test("worker rerun does not send completed jobs again", async () => {
  const repository = new FakeRepository(buildSeed());
  const provider = new MockNotificationProvider();
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);

  const testNow = new Date("2026-09-09T13:00:00+07:00");
  await processDueAutomationJobs(repository, provider, { now: testNow });
  await processDueAutomationJobs(repository, provider, { now: testNow });

  assert.equal(provider.sent.filter((item) => item.type === JOB_TYPES.confirmation).length, 1);
  assert.equal(provider.sent.filter((item) => item.type === JOB_TYPES.reminder).length, 1);
});

test("reminder is scheduled from configurable hours before start", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, { ...config, reminderHoursBefore: 2 });

  const reminder = repository.automationJobs.find((job) => job.automation_type === JOB_TYPES.reminder);
  assert.equal(new Date(reminder.scheduled_at).toISOString(), "2026-09-10T04:00:00.000Z");
});

test("reschedule cancels old reminder and creates a new reminder", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);

  const updated = {
    ...booking,
    start_at: "2026-09-10T14:00:00.000Z",
    end_at: "2026-09-10T15:00:00.000Z"
  };
  await handleBookingRescheduled(repository, updated, config);
  await handleBookingRescheduled(repository, updated, config);

  const reminders = repository.automationJobs.filter((job) => job.automation_type === JOB_TYPES.reminder);
  assert.equal(reminders.length, 2);
  assert.equal(reminders.filter((job) => job.status === "cancelled").length, 1);
  assert.equal(reminders.filter((job) => job.status === "pending").length, 1);
});

test("cancel marks pending reminders cancelled and schedules cancellation notification", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);
  const cancelled = { ...booking, status: "cancelled" };

  await handleBookingCancelled(repository, cancelled);

  const reminder = repository.automationJobs.find((job) => job.automation_type === JOB_TYPES.reminder);
  const cancellation = repository.automationJobs.find((job) => job.automation_type === JOB_TYPES.cancellation);
  assert.equal(reminder.status, "cancelled");
  assert.ok(cancellation);
});

test("no-show detection updates booking status, writes history, and schedules follow-up", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");

  const detected = await detectNoShows(repository, new Date("2026-09-10T13:20:00+07:00"), config);

  assert.equal(detected.length, 1);
  assert.equal(repository.bookings.find((row) => row.id === booking.id).status, "no_show");
  assert.ok(repository.bookingStatusHistory.some((row) => row.to_status === "no_show"));
  assert.ok(repository.automationJobs.some((job) => job.automation_type === JOB_TYPES.noShowFollowup));
});

test("completed booking schedules post-service follow-up", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");

  await handleBookingCompleted(repository, { ...booking, status: "completed" }, config);

  const job = repository.automationJobs.find((row) => row.automation_type === JOB_TYPES.postServiceFollowup);
  assert.ok(job);
  assert.equal(new Date(job.scheduled_at).toISOString(), "2026-09-11T07:00:00.000Z");
});

test("provider failure leaves job failed so it can be retried", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);
  const failingProvider = new MockNotificationProvider({ failTypes: [JOB_TYPES.confirmation] });

  const testNow = new Date("2026-09-09T13:00:00+07:00");
  const firstRun = await processDueAutomationJobs(repository, failingProvider, {
    now: testNow
  });
  assert.ok(firstRun.some((result) => result.status === "failed"));
  assert.ok(repository.automationJobs.some((job) => job.status === "failed" && job.attempts === 1));

  const provider = new MockNotificationProvider();
  await processDueAutomationJobs(repository, provider, {
    now: testNow
  });
  assert.ok(repository.automationJobs.some((job) => job.status === "completed" && job.attempts === 2));
});

test("automation runner reconciles missing jobs after persisted booking state", async () => {
  const repository = new FakeRepository(buildSeed());
  const confirmed = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  repository.automationJobs = [];

  const result = await reconcileAutomationJobs(repository, config);

  assert.equal(result.confirmed, 1);
  assert.equal(repository.automationJobs.filter((job) => job.booking_id === confirmed.id).length, 2);
});

test("automation runner detects no-show before reconciliation so stale reminders are not created", async () => {
  const repository = new FakeRepository(buildSeed());
  await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  repository.automationJobs = [];

  await runAutomationCycle(repository, {
    config,
    provider: new MockNotificationProvider(),
    now: new Date("2026-09-10T13:20:00+07:00")
  });

  assert.equal(repository.automationJobs.some((job) => job.automation_type === JOB_TYPES.reminder), false);
  assert.equal(repository.automationJobs.some((job) => job.automation_type === JOB_TYPES.noShowFollowup), true);
});

test("transaction rollback does not leave a half-created automation job", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");

  await assert.rejects(
    repository.transaction(async (tx) => {
      await tx.enqueueAutomationJob({
        booking_id: booking.id,
        automation_type: JOB_TYPES.confirmation,
        event_key: `booking-confirmed:${booking.id}`,
        scheduled_at: new Date().toISOString(),
        payload: {}
      });
      throw new Error("forced rollback");
    }),
    /forced rollback/
  );

  assert.equal(repository.automationJobs.length, 0);
});

async function makeBooking(repository, startAt) {
  return createBooking(repository, {
    customer: { name: "A", phone: `08${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}` },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: startAt,
    source: "test"
  });
}

test("outbox failure rolls back booking, customer and history together", async () => {
  const repository = new FakeRepository(buildSeed());
  repository.enqueueAutomationJob = async () => { throw new Error("outbox unavailable"); };
  const { createBooking: createWithJobs } = require("../src/automation/booking-orchestration");
  await assert.rejects(createWithJobs(repository, {
    customer: { name: "Rollback", phone: "0888888888" }, service_id: "svc-cut",
    staff_id: "staff-ann", start_at: "2026-09-10T13:00:00+07:00"
  }), /outbox unavailable/);
  assert.equal(repository.bookings.length, 0);
  assert.equal(repository.customers.length, 0);
  assert.equal(repository.bookingStatusHistory.length, 0);
});

test("claimed reminder is not sent after the booking is rescheduled", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);
  const claim = repository.claimDueAutomationJobs.bind(repository);
  repository.claimDueAutomationJobs = async (...args) => {
    const jobs = await claim(...args);
    await repository.updateBookingTime(booking.id, { staff_id: booking.staff_id,
      start_at: "2026-09-10T15:00:00+07:00", end_at: "2026-09-10T16:00:00+07:00", status: "confirmed" });
    return jobs;
  };
  const provider = new MockNotificationProvider();
  await processDueAutomationJobs(repository, provider, { now: "2026-09-09T13:00:00+07:00" });
  assert.equal(provider.sent.length, 0);
});

test("no-show detector rechecks a booking that checked in after candidate selection", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  repository.listConfirmedBookingsPastNoShowCutoff = async () => {
    const snapshot = { ...booking };
    booking.status = "checked_in";
    return [snapshot];
  };
  assert.equal((await detectNoShows(repository, new Date("2026-09-10T14:00:00+07:00"), config)).length, 0);
  assert.equal(booking.status, "checked_in");
});

test("retry after delivery but before completion uses the same provider idempotency key", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeBooking(repository, "2026-09-10T13:00:00+07:00");
  await handleBookingCreated(repository, booking, config);
  const complete = repository.completeAutomationJob;
  repository.completeAutomationJob = async () => { throw new Error("lost database connection"); };
  const provider = new MockNotificationProvider();
  const options = { now: "2026-09-09T13:00:00+07:00" };
  await processDueAutomationJobs(repository, provider, options);
  repository.completeAutomationJob = complete;
  await processDueAutomationJobs(repository, provider, options);
  assert.equal(provider.sent.length, 2);
  assert.ok(repository.automationJobs.every((job) => job.status === "completed"));
});
