const test = require("node:test");
const assert = require("node:assert/strict");

const {
  JOB_TYPES,
  handleBookingCreated,
  processDueAutomationJobs,
  runAutomationCycle
} = require("../src/automation/automation-service");
const { createBooking } = require("../src/automation/booking-orchestration");
const { MockNotificationProvider } = require("../src/automation/providers");
const { FakeRepository, buildSeed } = require("./fake-repository");
const {
  FEATURES,
  StaticProvider,
  EntitlementService,
  DEFAULT_SINGLE_BUSINESS_ID,
  resetEntitlementService
} = require("../src/licensing");

function setupFixture(pkg = "AI_PRO") {
  resetEntitlementService();
  const provider = new StaticProvider({ defaultPackage: pkg });
  const entService = new EntitlementService(provider);
  const repository = new FakeRepository(buildSeed());
  const notificationProvider = new MockNotificationProvider();

  const options = {
    businessId: DEFAULT_SINGLE_BUSINESS_ID,
    entitlementService: entService
  };

  return { repository, notificationProvider, entService, provider, options };
}

const serviceId = "svc-cut";
const staffId = "staff-ann";

async function makeBookingInput(startAt = "2026-09-10T13:00:00+07:00") {
  return {
    customer: { name: "สมศรี", phone: "0812345678" },
    service_id: serviceId,
    staff_id: staffId,
    start_at: startAt,
    now: "2026-09-10T09:00:00+07:00",
    source: "web"
  };
}

test("AI_PRO: booking creates automation jobs and worker executes normally", async () => {
  const { repository, notificationProvider, options } = setupFixture("AI_PRO");
  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  const booking = await createBooking(repository, input, options);
  assert.ok(booking.id);
  assert.equal(booking.status, "confirmed");

  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.confirmation).length, 1);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.reminder).length, 1);

  // Worker execution
  const testNow = new Date("2026-09-09T13:00:00+07:00");
  const result = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...options
  });

  assert.ok(result.some((r) => r.status === "completed"));
  assert.ok(notificationProvider.sent.length > 0);
});

test("PRO: booking creates automation jobs and worker executes normally", async () => {
  const { repository, notificationProvider, options } = setupFixture("PRO");
  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  const booking = await createBooking(repository, input, options);
  assert.ok(booking.id);
  assert.equal(booking.status, "confirmed");

  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.confirmation).length, 1);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.reminder).length, 1);

  const testNow = new Date("2026-09-09T13:00:00+07:00");
  const result = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...options
  });

  assert.ok(result.some((r) => r.status === "completed"));
  assert.ok(notificationProvider.sent.length > 0);
});

test("BASIC: booking succeeds but automation jobs are NOT created", async () => {
  const { repository, options } = setupFixture("BASIC");
  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  // Booking Core succeeds completely
  const booking = await createBooking(repository, input, options);
  assert.ok(booking.id);
  assert.equal(booking.status, "confirmed");

  // Enqueue gate: 0 automation jobs enqueued
  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.length, 0);
});

test("Downgrade PRO -> BASIC: worker does NOT send notification, marks cancelled, avoids retry storm", async () => {
  // 1. Created under PRO
  const { repository, notificationProvider, options, provider, entService } = setupFixture("PRO");
  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  const booking = await createBooking(repository, input, options);
  const jobsBefore = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobsBefore.length, 2);

  // 2. Shop downgrades to BASIC before execution
  provider.defaultPackage = "BASIC";
  entService.invalidateEntitlementCache(DEFAULT_SINGLE_BUSINESS_ID);

  // 3. Worker runs
  const testNow = new Date(Date.now() + 1000);
  const results = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...options
  });

  // Notification provider is NOT called
  assert.equal(notificationProvider.sent.length, 0);

  // Worker results report cancelled
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.status === "cancelled"));

  // Jobs remain in repository with status 'cancelled' for auditability (not deleted)
  const jobsAfter = await repository.listAutomationJobsForBooking(booking.id);
  const confirmationJob = jobsAfter.find((j) => j.automation_type === JOB_TYPES.confirmation);
  assert.ok(confirmationJob);
  assert.equal(confirmationJob.status, "cancelled");

  // Subsequent worker run does not claim or retry cancelled jobs (no retry storm)
  const rerunResults = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...options
  });
  assert.equal(rerunResults.length, 0);
  assert.equal(notificationProvider.sent.length, 0);
});

test("Provider error at enqueue: booking succeeds and fail-closed does not create jobs", async () => {
  const repository = new FakeRepository(buildSeed());
  const crashingProvider = {
    async getEntitlements() {
      throw new Error("License DB network timeout 504");
    }
  };
  const entService = new EntitlementService(crashingProvider);
  const options = {
    businessId: DEFAULT_SINGLE_BUSINESS_ID,
    entitlementService: entService
  };

  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  // Booking Core MUST succeed
  const booking = await createBooking(repository, input, options);
  assert.ok(booking.id);
  assert.equal(booking.status, "confirmed");

  // Fail-closed: no jobs enqueued
  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.length, 0);
});

test("Provider error at worker: notification provider is NOT called and job cancelled without retry loop", async () => {
  // Create job under PRO
  const { repository, notificationProvider, options } = setupFixture("PRO");
  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");
  const booking = await createBooking(repository, input, options);

  // Inject error on worker entitlement check
  const workerOptions = {
    businessId: DEFAULT_SINGLE_BUSINESS_ID,
    hasFeatureFn: async () => {
      const err = new Error("License server outage 500");
      err.code = "ENTITLEMENT_PROVIDER_ERROR";
      throw err;
    }
  };

  const testNow = new Date(Date.now() + 1000);
  const results = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...workerOptions
  });

  // Notification provider call count = 0
  assert.equal(notificationProvider.sent.length, 0);

  // Job cancelled safely
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.status === "cancelled"));

  // Check job status in repository
  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  const confirmationJob = jobs.find((j) => j.automation_type === JOB_TYPES.confirmation);
  assert.equal(confirmationJob.status, "cancelled");

  // No retry storm
  const rerun = await processDueAutomationJobs(repository, notificationProvider, {
    now: testNow,
    ...workerOptions
  });
  assert.equal(rerun.length, 0);
});

test("Default runtime configuration defaults to AI_PRO preserving existing production automation behavior", async () => {
  resetEntitlementService();
  const repository = new FakeRepository(buildSeed());
  const notificationProvider = new MockNotificationProvider();

  const input = await makeBookingInput("2026-09-10T13:00:00+07:00");

  // Standard call without passing options uses global defaults (AI_PRO)
  const booking = await createBooking(repository, input);
  assert.ok(booking.id);

  const jobs = await repository.listAutomationJobsForBooking(booking.id);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.confirmation).length, 1);
  assert.equal(jobs.filter((j) => j.automation_type === JOB_TYPES.reminder).length, 1);

  const testNow = new Date("2026-09-09T13:00:00+07:00");
  await processDueAutomationJobs(repository, notificationProvider, { now: testNow });
  assert.ok(notificationProvider.sent.length > 0);
});
