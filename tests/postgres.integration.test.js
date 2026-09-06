const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const shouldRun = Boolean(process.env.TEST_DATABASE_URL);
test.after(async () => { await require("../src/repositories").closeRepository(); });
const { randomBytes, scryptSync } = require("node:crypto");
const adminSalt = randomBytes(16).toString("hex");
process.env.ADMIN_PASSWORD_HASH = `scrypt$${adminSalt}$${scryptSync("integration-admin-password", adminSalt, 32).toString("hex")}`;
process.env.ADMIN_SESSION_SECRET = "integration-admin-session-secret-32-chars";
process.env.AUTOMATION_RETRY_BASE_SECONDS = "0";
// Existing admin/booking baseline scenarios now authenticate at the new HTTP boundary.
class Request extends globalThis.Request {
  constructor(url, options) {
    super(url, options);
    this.headers.set("cookie", `salon_admin=${require("../src/security/access").adminToken()}`);
  }
}

test("PostgreSQL integration: booking lifecycle and transaction rules", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg");
  const { getAvailableSlots } = require("../src/availability-engine");
  const {
    cancelBooking,
    createBooking,
    rescheduleBooking
  } = require("../src/booking-service");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");

  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    await resetDatabase(pool);
    await seedDeterministicData(pool);

    const beforeBooking = await getAvailableSlots(repository, {
      serviceId: ids.cut,
      staffId: ids.ann,
      date: "2026-09-10"
    });
    assert.ok(beforeBooking.slots.some((slot) => slot.start_at === "2026-09-10T13:00:00+07:00"));

    const booking = await createBooking(repository, {
      customer: { name: "Customer A", phone: "0800000000" },
      service_id: ids.cut,
      staff_id: ids.ann,
      start_at: "2026-09-10T13:00:00+07:00",
      source: "web"
    });
    assert.equal(booking.status, "confirmed");

    await assert.rejects(
      createBooking(repository, {
        customer: { name: "Customer B", phone: "0800000001" },
        service_id: ids.cut,
        staff_id: ids.ann,
        start_at: "2026-09-10T13:30:00+07:00",
        source: "web"
      }),
      /requested slot is not available/
    );

    await assert.rejects(
      repository.transaction(async (tx) => {
        const customer = await tx.insertCustomer({ name: "Customer C" });
        await tx.insertBooking({
          customer_id: customer.id,
          service_id: ids.cut,
          staff_id: ids.ann,
          start_at: "2026-09-10T13:15:00+07:00",
          end_at: "2026-09-10T14:15:00+07:00",
          status: "confirmed",
          source: "test",
          notes: null
        });
      }),
      /overlaps an existing active booking/
    );

    const moved = await rescheduleBooking(repository, booking.id, {
      staff_id: ids.ann,
      start_at: "2026-09-10T14:00:00+07:00",
      reason: "customer request"
    });
    assert.equal(new Date(moved.start_at).toISOString(), "2026-09-10T07:00:00.000Z");

    const second = await createBooking(repository, {
      customer: { name: "Customer D", phone: "0800000002" },
      service_id: ids.cut,
      staff_id: ids.ann,
      start_at: "2026-09-10T15:00:00+07:00",
      source: "web"
    });
    assert.ok(second.id);

    await assert.rejects(
      rescheduleBooking(repository, booking.id, {
        staff_id: ids.ann,
        start_at: "2026-09-10T15:15:00+07:00"
      }),
      /requested slot is not available/
    );

    const availabilityAfterBookings = await getAvailableSlots(repository, {
      serviceId: ids.cut,
      staffId: ids.ann,
      date: "2026-09-10"
    });
    assert.ok(!availabilityAfterBookings.slots.some((slot) => slot.start_at === "2026-09-10T14:00:00+07:00"));

    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const availabilityRoute = require("../app/api/availability/route");
    const createBookingRoute = require("../app/api/bookings/route");
    const bookingRoute = require("../app/api/bookings/[id]/route");
    const rescheduleRoute = require("../app/api/bookings/[id]/reschedule/route");
    const cancelRoute = require("../app/api/bookings/[id]/cancel/route");
    const statusRoute = require("../app/api/bookings/[id]/status/route");
    const adminBookingsRoute = require("../app/api/admin/bookings/route");
    const endpointResponse = await availabilityRoute.GET(new Request(
      `http://localhost/api/availability?service_id=${ids.cut}&staff_id=${ids.ann}&date=2026-09-10`
    ));
    const endpointBody = await endpointResponse.json();
    assert.equal(endpointResponse.status, 200);
    assert.ok(!endpointBody.data.slots.some((slot) => slot.start_at === "2026-09-10T14:00:00+07:00"));

    const detailResponse = await bookingRoute.GET(new Request("http://localhost/api/bookings"), {
      params: { id: booking.id }
    });
    const detailBody = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detailBody.data.service.name, "Cut");
    assert.equal(detailBody.data.staff.name, "Ann");

    const customerCreateResponse = await createBookingRoute.POST(new Request("http://localhost/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Route Customer", phone: "0800000099" },
        service_id: ids.cut,
        staff_id: ids.mean,
        start_at: "2026-09-10T10:00:00+07:00",
        source: "web"
      })
    }));
    const customerCreateBody = await customerCreateResponse.json();
    assert.equal(customerCreateResponse.status, 201);
    assert.equal(customerCreateBody.data.status, "confirmed");

    const conflictResponse = await createBookingRoute.POST(new Request("http://localhost/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Route Conflict", phone: "0800000098" },
        service_id: ids.cut,
        staff_id: ids.mean,
        start_at: "2026-09-10T10:15:00+07:00",
        source: "web"
      })
    }));
    const conflictBody = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409);
    assert.equal(conflictBody.error.code, "CONFLICT");

    const customerRescheduleResponse = await rescheduleRoute.POST(new Request("http://localhost/api/bookings/reschedule", {
      method: "POST",
      body: JSON.stringify({
        staff_id: ids.mean,
        start_at: "2026-09-10T11:00:00+07:00",
        reason: "route reschedule"
      })
    }), { params: { id: customerCreateBody.data.id } });
    const customerRescheduleBody = await customerRescheduleResponse.json();
    assert.equal(customerRescheduleResponse.status, 200);
    assert.equal(new Date(customerRescheduleBody.data.start_at).toISOString(), "2026-09-10T04:00:00.000Z");

    const customerCancelResponse = await cancelRoute.POST(new Request("http://localhost/api/bookings/cancel", {
      method: "POST",
      body: JSON.stringify({
        actor: "customer",
        reason: "route cancel"
      })
    }), { params: { id: customerCreateBody.data.id } });
    const customerCancelBody = await customerCancelResponse.json();
    assert.equal(customerCancelResponse.status, 200);
    assert.equal(customerCancelBody.data.status, "cancelled");

    const adminResponse = await adminBookingsRoute.GET(new Request(
      "http://localhost/api/admin/bookings?date=2026-09-10"
    ));
    const adminBody = await adminResponse.json();
    assert.equal(adminResponse.status, 200);
    assert.ok(adminBody.data.bookings.some((item) => item.id === booking.id));

    const statusResponse = await statusRoute.PATCH(new Request("http://localhost/api/bookings/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "checked_in", reason: "arrived" })
    }), { params: { id: second.id } });
    const statusBody = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.data.status, "checked_in");
    await require("../src/repositories").closeRepository();

    await cancelBooking(repository, booking.id, {
      actor: "customer",
      now: "2026-09-09T12:00:00+07:00",
      reason: "customer request"
    });
    const availabilityAfterCancel = await getAvailableSlots(repository, {
      serviceId: ids.cut,
      staffId: ids.ann,
      date: "2026-09-10"
    });
    assert.ok(availabilityAfterCancel.slots.some((slot) => slot.start_at === "2026-09-10T14:00:00+07:00"));

    await assert.rejects(
      createBooking(repository, {
        customer: { name: "Customer E", phone: "0800000003" },
        service_id: ids.color,
        staff_id: ids.mean,
        start_at: "2026-09-10T10:00:00+07:00",
        source: "web"
      }),
      /staff cannot perform service/
    );

    await assert.rejects(
      repository.transaction(async (tx) => {
        await tx.insertCustomer({ name: "Rollback Customer", phone: "0999999999" });
        throw new Error("forced rollback");
      }),
      /forced rollback/
    );
    const rollbackRows = await pool.query("select * from customers where phone = '0999999999'");
    assert.equal(rollbackRows.rowCount, 0);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL integration: automation jobs and worker lifecycle", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg");
  const {
    JOB_TYPES,
    processDueAutomationJobs
  } = require("../src/automation/automation-service");
  const { MockNotificationProvider } = require("../src/automation/providers");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");

  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    await resetDatabase(pool);
    await seedDeterministicData(pool);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.AUTOMATION_INTERNAL_SECRET = "test-secret";

    const createBookingRoute = require("../app/api/bookings/route");
    const rescheduleRoute = require("../app/api/bookings/[id]/reschedule/route");
    const cancelRoute = require("../app/api/bookings/[id]/cancel/route");
    const statusRoute = require("../app/api/bookings/[id]/status/route");
    const internalRunRoute = require("../app/api/internal/automation/run/route");

    const createResponse = await createBookingRoute.POST(new Request("http://localhost/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Automation Customer", phone: "0811111111" },
        service_id: ids.cut,
        staff_id: ids.ann,
        start_at: "2026-09-10T13:00:00+07:00",
        source: "web"
      })
    }));
    const createBody = await createResponse.json();
    assert.equal(createResponse.status, 201);

    const initialJobs = await repository.listAutomationJobsForBooking(createBody.data.id);
    assert.equal(initialJobs.filter((job) => job.automation_type === JOB_TYPES.confirmation).length, 1);
    assert.equal(initialJobs.filter((job) => job.automation_type === JOB_TYPES.reminder).length, 1);
    const reminder = initialJobs.find((job) => job.automation_type === JOB_TYPES.reminder);
    assert.equal(new Date(reminder.scheduled_at).toISOString(), "2026-09-09T06:00:00.000Z");

    const provider = new MockNotificationProvider();
    await processDueAutomationJobs(repository, provider, {
      now: new Date("2026-09-09T13:00:00+07:00")
    });
    await processDueAutomationJobs(repository, provider, {
      now: new Date("2026-09-09T13:00:00+07:00")
    });
    assert.equal(provider.sent.length, 2);

    const rescheduleResponse = await rescheduleRoute.POST(new Request("http://localhost/api/bookings/reschedule", {
      method: "POST",
      body: JSON.stringify({
        staff_id: ids.ann,
        start_at: "2026-09-10T14:00:00+07:00",
        reason: "automation route reschedule"
      })
    }), { params: { id: createBody.data.id } });
    assert.equal(rescheduleResponse.status, 200);
    const rescheduledJobs = await repository.listAutomationJobsForBooking(createBody.data.id);
    assert.ok(rescheduledJobs.some((job) => job.automation_type === JOB_TYPES.reminder && job.status === "completed"));
    assert.ok(rescheduledJobs.some((job) => job.automation_type === JOB_TYPES.reminder && job.status === "pending"));

    const cancelResponse = await cancelRoute.POST(new Request("http://localhost/api/bookings/cancel", {
      method: "POST",
      body: JSON.stringify({ actor: "customer", reason: "automation route cancel" })
    }), { params: { id: createBody.data.id } });
    assert.equal(cancelResponse.status, 200);
    const cancelledJobs = await repository.listAutomationJobsForBooking(createBody.data.id);
    assert.ok(cancelledJobs.some((job) => job.automation_type === JOB_TYPES.reminder && job.status === "cancelled"));
    assert.ok(cancelledJobs.some((job) => job.automation_type === JOB_TYPES.cancellation && job.status === "pending"));

    const completed = await createBookingRoute.POST(new Request("http://localhost/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: "Complete Customer", phone: "0822222222" },
        service_id: ids.cut,
        staff_id: ids.mean,
        start_at: "2026-09-10T10:00:00+07:00",
        source: "web"
      })
    }));
    const completedBody = await completed.json();
    const completedStatus = await statusRoute.PATCH(new Request("http://localhost/api/bookings/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "completed", reason: "done" })
    }), { params: { id: completedBody.data.id } });
    assert.equal(completedStatus.status, 200);
    const completedJobs = await repository.listAutomationJobsForBooking(completedBody.data.id);
    assert.ok(completedJobs.some((job) => job.automation_type === JOB_TYPES.postServiceFollowup));

    const failingJob = await repository.enqueueAutomationJob({
      booking_id: completedBody.data.id,
      automation_type: JOB_TYPES.postServiceFollowup,
      event_key: `forced-provider-failure:${completedBody.data.id}`,
      scheduled_at: new Date("2026-09-09T00:00:00Z").toISOString(),
      payload: { followup_type: JOB_TYPES.postServiceFollowup }
    });
    const failingProvider = new MockNotificationProvider({ failTypes: [JOB_TYPES.postServiceFollowup] });
    await processDueAutomationJobs(repository, failingProvider, { now: new Date("2026-09-10T00:00:00Z") });
    const failed = (await pool.query("select * from automation_jobs where id = $1", [failingJob.id])).rows[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    failingProvider.failTypes.clear();
    await processDueAutomationJobs(repository, failingProvider, { now: new Date("2026-09-10T00:00:00Z") });
    const retried = (await pool.query("select * from automation_jobs where id = $1", [failingJob.id])).rows[0];
    assert.equal(retried.status, "completed");
    assert.equal(retried.attempts, 2);

    await assert.rejects(
      repository.transaction(async (tx) => {
        await tx.enqueueAutomationJob({
          booking_id: completedBody.data.id,
          automation_type: JOB_TYPES.confirmation,
          event_key: "forced-rollback-job",
          scheduled_at: new Date().toISOString(),
          payload: {}
        });
        throw new Error("forced automation rollback");
      }),
      /forced automation rollback/
    );
    const rollbackJob = await pool.query("select * from automation_jobs where event_key = 'forced-rollback-job'");
    assert.equal(rollbackJob.rowCount, 0);

    const oldCustomer = await repository.insertCustomer({ name: "Old Customer", phone: "0833333333" });
    const oldBooking = await repository.insertBooking({
      customer_id: oldCustomer.id,
      service_id: ids.cut,
      staff_id: ids.mean,
      start_at: "2026-01-01T10:00:00+07:00",
      end_at: "2026-01-01T11:00:00+07:00",
      status: "confirmed",
      source: "test",
      notes: null
    });
    const protectedResponse = await internalRunRoute.POST(new Request("http://localhost/api/internal/automation/run", {
      method: "POST",
      headers: { "x-automation-secret": "test-secret" }
    }));
    assert.equal(protectedResponse.status, 200);
    const noShowBooking = await repository.getBookingDetail(oldBooking.id);
    assert.equal(noShowBooking.status, "no_show");
    assert.ok(noShowBooking.history.some((history) => history.to_status === "no_show"));
    const noShowJobs = await repository.listAutomationJobsForBooking(oldBooking.id);
    assert.ok(noShowJobs.some((job) => job.automation_type === JOB_TYPES.noShowFollowup));

    const deniedResponse = await internalRunRoute.POST(new Request("http://localhost/api/internal/automation/run", {
      method: "POST"
    }));
    assert.equal(deniedResponse.status, 403);

    await require("../src/repositories").closeRepository();
  } finally {
    await pool.end();
  }
});

test("PostgreSQL integration: atomic outbox, concurrent workers and stale job recovery", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");
  const orchestration = require("../src/automation/booking-orchestration");
  const { processDueAutomationJobs, detectNoShows } = require("../src/automation/automation-service");
  const { MockNotificationProvider } = require("../src/automation/providers");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repository = new PgBookingRepository({ pool });
  const input = { customer: { name: "Atomic", phone: "0891234567" }, service_id: ids.cut,
    staff_id: ids.ann, start_at: "2026-09-10T13:00:00+07:00" };
  try {
    await resetDatabase(pool);
    await seedDeterministicData(pool);
    const migration = await fs.readFile(path.join(__dirname, "../database/migrations/004_automation_jobs.sql"), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    await pool.query(`create function fail_outbox() returns trigger language plpgsql as $$
      begin raise exception 'outbox unavailable'; end; $$;
      create trigger fail_outbox before insert on automation_jobs for each row execute function fail_outbox()`);
    await assert.rejects(orchestration.createBooking(repository, input), /outbox unavailable/);
    for (const table of ["bookings", "customers", "booking_status_history", "automation_jobs"]) {
      assert.equal((await pool.query(`select count(*)::int as count from ${table}`)).rows[0].count, 0);
    }
    await pool.query("drop trigger fail_outbox on automation_jobs");
    const booking = await orchestration.createBooking(repository, input);
    const initial = await repository.listAutomationJobsForBooking(booking.id);
    await repository.refreshPendingReminderSchedule(2);
    assert.equal((await repository.listAutomationJobsForBooking(booking.id))
      .find((job) => job.automation_type === "appointment_reminder").scheduled_at.toISOString(), "2026-09-10T04:00:00.000Z");
    await repository.refreshPendingReminderSchedule(24);
    await pool.query(`create trigger fail_outbox before insert on automation_jobs for each row execute function fail_outbox()`);
    await assert.rejects(orchestration.rescheduleBooking(repository, booking.id, {
      start_at: "2026-09-10T14:00:00+07:00"
    }), /outbox unavailable/);
    assert.equal((await repository.getBookingDetail(booking.id)).start_at.toISOString(), booking.start_at.toISOString());
    assert.equal((await repository.listAutomationJobsForBooking(booking.id)).filter((j) => j.status === "pending").length, 2);
    await pool.query("drop trigger fail_outbox on automation_jobs");

    const provider = new MockNotificationProvider();
    const options = { now: "2026-09-09T13:00:00+07:00" };
    await Promise.all([
      processDueAutomationJobs(repository, provider, options),
      processDueAutomationJobs(repository, provider, options)
    ]);
    assert.equal(provider.sent.length, 2);
    assert.equal((await pool.query("select count(*)::int as count from automation_logs")).rows[0].count, 2);

    await orchestration.rescheduleBooking(repository, booking.id, { start_at: "2026-09-10T14:00:00+07:00" });
    const claimed = await repository.claimDueAutomationJobs(new Date("2026-09-09T15:00:00+07:00"));
    assert.equal(claimed.length, 2);
    await orchestration.cancelBooking(repository, booking.id, { actor: "staff" });
    // Simulate a process crash after claim. The lease expires using database time.
    await pool.query("alter table automation_jobs disable trigger automation_jobs_set_updated_at");
    await pool.query("update automation_jobs set updated_at = now() - interval '10 minutes' where status = 'processing'");
    await pool.query("alter table automation_jobs enable trigger automation_jobs_set_updated_at");
    const recovered = await processDueAutomationJobs(repository, provider, options);
    assert.ok(recovered.some((job) => job.status === "cancelled"));
    assert.equal(provider.sent.filter((item) => item.type === "appointment_reminder").length, 1);
    assert.equal((await pool.query("select count(*)::int as count from automation_jobs where status = 'processing'")).rows[0].count, 0);
    assert.equal(initial.length, 2);

    const overdue = await orchestration.createBooking(repository, { ...input, start_at: "2026-09-10T15:00:00+07:00" });
    const config = { noShowGraceMinutes: 15, noShowFollowupHours: 1 };
    await Promise.all([
      detectNoShows(repository, new Date("2026-09-10T16:00:00+07:00"), config),
      detectNoShows(repository, new Date("2026-09-10T16:00:00+07:00"), config)
    ]);
    const detail = await repository.getBookingDetail(overdue.id);
    assert.equal(detail.history.filter((h) => h.to_status === "no_show").length, 1);
  } finally {
    await pool.end();
  }
});

test("PostgreSQL integration: AI gateway confirmation, conflicts, verification and policy", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");
  const { Receptionist } = require("../src/ai/receptionist");
  const { ToolGateway } = require("../src/ai/tools/gateway");
  const { apiClient } = require("../src/ai/tools/api-client");
  const { MemorySessionStore } = require("../src/ai/sessions");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repository = new PgBookingRepository({ pool });
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  try {
    await resetDatabase(pool); await seedDeterministicData(pool);
    const gateway = new ToolGateway(apiClient); const engine = new Receptionist(gateway);
    const sessions = new MemorySessionStore();
    const prepare = async (phone) => {
      const session = sessions.create();
      for (const message of ["บริการ", "Cut", "Ann", "2026-09-10", `${ids.ann} 2026-09-10T13:00:00+07:00`, `Customer ${phone}`])
        await engine.respond(session, message);
      assert.ok(session.pending); return session;
    };
    const a = await prepare("0812345678"); const b = await prepare("0899999999");
    assert.equal((await pool.query("select count(*)::int as n from bookings")).rows[0].n, 0);
    const results = await Promise.all([engine.respond(a, "ยืนยัน"), engine.respond(b, "ยืนยัน")]);
    assert.equal(results.filter((r) => r.state.stage === "success").length, 1);
    assert.equal(results.filter((r) => /ยังจองไม่สำเร็จ/.test(r.message)).length, 1);
    const winner = a.booking ? a : b; const loser = a.booking ? b : a;
    assert.ok(!loser.slots.some((s) => s.start_at === "2026-09-10T13:00:00+07:00"));
    const booking = winner.booking;
    const detailRoute = require("../app/api/bookings/[id]/route");
    assert.equal((await detailRoute.GET(new globalThis.Request("http://localhost/api/bookings"), { params: { id: booking.id } })).status, 403);
    assert.equal((await gateway.execute("get_booking", { booking_id: booking.id, phone: "0800000000" })).error.code, "FORBIDDEN");
    assert.equal((await gateway.execute("get_booking", { booking_id: booking.id, phone: winner.customer.phone })).ok, true);
    await engine.respond(winner, "เลื่อนนัด"); await engine.respond(winner, "2026-09-10");
    await engine.respond(winner, `${ids.ann} 2026-09-10T14:00:00+07:00`);
    assert.ok(winner.pending);
    assert.match((await engine.respond(winner, "ยืนยัน")).message, /เลื่อนนัดสำเร็จ/);
    const moved = await repository.getBookingDetail(booking.id);
    assert.equal(moved.start_at.toISOString(), "2026-09-10T07:00:00.000Z");
    assert.ok(moved.history.some((h) => /customer via receptionist/.test(h.reason)));
    await engine.respond(winner, "ยกเลิกนัด"); assert.ok(winner.pending);
    assert.match((await engine.respond(winner, "ยืนยัน")).message, /ยกเลิกนัดสำเร็จ/);
    assert.equal((await repository.getBookingDetail(booking.id)).status, "cancelled");

    const customer = await repository.insertCustomer({ name: "Policy", phone: "0877777777" });
    const old = await repository.insertBooking({ customer_id: customer.id, service_id: ids.cut, staff_id: ids.mean,
      start_at: "2026-01-01T10:00:00+07:00", end_at: "2026-01-01T11:00:00+07:00", status: "confirmed" });
    const managed = sessions.create();
    const found = await engine.respond(managed, `ดูนัด ${old.id} 0877777777`);
    assert.equal(found.state.booking.id, old.id);
    await engine.respond(managed, "ยกเลิกนัด");
    const denied = await engine.respond(managed, "ยืนยัน");
    assert.equal(denied.handoff, true); assert.equal((await repository.getBookingDetail(old.id)).status, "confirmed");
    const cancelRoute = require("../app/api/bookings/[id]/cancel/route");
    const spoof = await cancelRoute.POST(new globalThis.Request("http://localhost/api/bookings/cancel", { method: "POST",
      headers: { "x-booking-phone": "0877777777" }, body: JSON.stringify({ actor: "staff" }) }), { params: { id: old.id } });
    assert.equal(spoof.status, 403);
    const admin = require("../app/api/admin/bookings/route");
    assert.equal((await admin.GET(new globalThis.Request("http://localhost/api/admin/bookings?date=2026-09-10"))).status, 403);
    const status = require("../app/api/bookings/[id]/status/route");
    assert.equal((await status.PATCH(new globalThis.Request("http://localhost/api/bookings/status", { method: "PATCH", body: '{"status":"cancelled"}' }), { params: { id: old.id } })).status, 403);
    const endpoint = require("../app/api/ai/receptionist/route");
    const firstResponse = await endpoint.POST(new globalThis.Request("http://localhost/api/ai/receptionist", { method: "POST", body: JSON.stringify({ message: "บริการ" }) }));
    const body = await firstResponse.json(); assert.equal(firstResponse.status, 200);
    const withoutCookie = await endpoint.POST(new globalThis.Request("http://localhost/api/ai/receptionist", { method: "POST", body: JSON.stringify({ session_id: body.data.session_id, message: "ยืนยัน" }) }));
    assert.equal(withoutCookie.status, 403);
    assert.doesNotMatch(JSON.stringify(body), /DATABASE_URL|ADMIN_PASSWORD|System Prompt/);
  } finally { await require("../src/repositories").closeRepository(); await pool.end(); }
});

test("PostgreSQL integration: retry backoff, max attempts and dead letter retention", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg"); const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");
  const { processDueAutomationJobs } = require("../src/automation/automation-service");
  const { MockNotificationProvider } = require("../src/automation/providers");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); const repository = new PgBookingRepository({ pool });
  process.env.AUTOMATION_MAX_ATTEMPTS = "2"; process.env.AUTOMATION_RETRY_BASE_SECONDS = "10";
  try {
    await resetDatabase(pool); await seedDeterministicData(pool);
    const migration = await fs.readFile(path.join(__dirname, "../database/migrations/005_automation_retry.sql"), "utf8");
    await pool.query(migration); await pool.query(migration);
    const customer = await repository.insertCustomer({ name: "Retry", phone: "0866666666" });
    const booking = await repository.insertBooking({ customer_id: customer.id, service_id: ids.cut, staff_id: ids.ann,
      start_at: "2026-09-10T10:00:00+07:00", end_at: "2026-09-10T11:00:00+07:00", status: "cancelled" });
    const job = await repository.enqueueAutomationJob({ booking_id: booking.id, automation_type: "booking_cancellation",
      event_key: "retry-test", scheduled_at: "2026-09-09T00:00:00Z", payload: {} });
    const provider = new MockNotificationProvider({ failTypes: ["booking_cancellation"] });
    await processDueAutomationJobs(repository, provider, { now: "2026-09-09T00:00:00Z" });
    let row = (await repository.listAutomationJobsForBooking(booking.id))[0];
    assert.equal(row.scheduled_at.toISOString(), "2026-09-09T00:00:10.000Z"); assert.equal(row.attempts, 1);
    assert.equal((await processDueAutomationJobs(repository, provider, { now: "2026-09-09T00:00:09Z" })).length, 0);
    await processDueAutomationJobs(repository, provider, { now: "2026-09-09T00:00:10Z" });
    row = (await repository.listAutomationJobsForBooking(booking.id))[0];
    assert.equal(row.id, job.id); assert.equal(row.status, "failed"); assert.equal(row.attempts, 2); assert.ok(row.dead_lettered_at);
    provider.failTypes.clear();
    assert.equal((await processDueAutomationJobs(repository, provider, { now: "2026-09-12T00:00:00Z" })).length, 0);
  } finally { delete process.env.AUTOMATION_MAX_ATTEMPTS; process.env.AUTOMATION_RETRY_BASE_SECONDS = "0"; await pool.end(); }
});

test("PostgreSQL integration: persistent AI state, LINE flow, handoff and admin logout", { skip: !shouldRun }, async () => {
  const { Pool } = require("pg");
  const { PgPilotRepository } = require("../src/repositories/pg-pilot-repository");
  const { PersistentSessionStore } = require("../src/ai/persistent-sessions");
  const { PersistentRateLimiter } = require("../src/security/persistent-rate-limit");
  const { createHmac } = require("node:crypto");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.AI_ENABLED = "true"; process.env.AI_PROVIDER = "mock";
  process.env.LINE_ENABLED = "true"; process.env.LINE_CHANNEL_SECRET = "integration-line-channel-secret";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "integration-line-access-token-value";
  process.env.BUSINESS_CONTACT = "02-000-0000"; process.env.HANDOFF_DESTINATION = "front-desk";
  const originalFetch = globalThis.fetch; const deliveries = [];
  try {
    await resetDatabase(pool); await seedDeterministicData(pool);
    const pilot = new PgPilotRepository({ pool });
    const firstStore = new PersistentSessionStore(pilot);
    const created = await firstStore.create({ type: "web" });
    await firstStore.withSession(created.session.id, created.owner, async (state) => { state.stage = "staff"; state.service = { id: ids.cut, name: "Cut" }; });
    const restartedStore = new PersistentSessionStore(pilot);
    let restored;
    await restartedStore.withSession(created.session.id, created.owner, async (state) => { restored = state; });
    assert.equal(restored.stage, "staff"); assert.equal(restored.service.id, ids.cut);
    await assert.rejects(restartedStore.withSession(created.session.id, "wrong-owner", async () => {}), /เซสชัน/);

    const limiterA = new PersistentRateLimiter(pilot); const limiterB = new PersistentRateLimiter(pilot);
    await limiterA.consume("pilot-test", "customer", { max: 1, windowMs: 60000 });
    await assert.rejects(limiterB.consume("pilot-test", "customer", { max: 1, windowMs: 60000 }), /ถี่/);

    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /^https:\/\/api\.line\.me\//);
      deliveries.push(JSON.parse(options.body)); return { ok: true };
    };
    require("../src/ai/runtime").resetAIRuntime();
    const lineRoute = require("../app/api/line/webhook/route");
    let sequence = 0;
    const sendLine = async (userId, text) => {
      const raw = JSON.stringify({ events: [{ type: "message", webhookEventId: `event-${++sequence}`,
        replyToken: `reply-${sequence}`, source: { type: "user", userId }, message: { type: "text", id: String(sequence), text } }] });
      const signature = createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
      return lineRoute.POST(new globalThis.Request("http://localhost/api/line/webhook", { method: "POST",
        headers: { "x-line-signature": signature }, body: raw }));
    };
    const invalid = await lineRoute.POST(new globalThis.Request("http://localhost/api/line/webhook", { method: "POST",
      headers: { "x-line-signature": "invalid" }, body: '{"events":[]}' }));
    assert.equal(invalid.status, 401);

    const lineUser = "U-line-customer";
    for (const text of ["บริการ", "Cut", "Ann", "2026-09-10", `${ids.ann} 2026-09-10T13:00:00+07:00`, "Line Customer 0811112222"])
      assert.equal((await sendLine(lineUser, text)).status, 200);
    assert.equal((await pool.query("select count(*)::int as count from bookings")).rows[0].count, 0);
    assert.doesNotMatch(deliveries.at(-1).messages[0].text, /จองสำเร็จ/);
    assert.equal((await sendLine(lineUser, "ยืนยัน")).status, 200);
    assert.match(deliveries.at(-1).messages[0].text, /จองสำเร็จ/);
    const booking = (await pool.query(`select b.*,c.line_user_id from bookings b join customers c on c.id=b.customer_id`)).rows[0];
    assert.equal(booking.line_user_id, lineUser);
    const beforeDuplicate = deliveries.length;
    assert.equal((await sendLine(lineUser, "ยืนยัน")).status, 200);
    assert.equal((await pool.query("select count(*)::int as count from bookings")).rows[0].count, 1);
    assert.equal(deliveries.length, beforeDuplicate + 1);

    const handoffUser = "U-line-handoff";
    assert.equal((await sendLine(handoffUser, "ขอส่วนลดพิเศษ")).status, 200);
    assert.match(deliveries.at(-1).messages[0].text, /พนักงานจะรับช่วง/);
    const handoffs = await pilot.listHandoffs("pending");
    assert.equal(handoffs.length, 1); assert.equal(handoffs[0].reason, "discount_request");
    assert.equal((await sendLine(handoffUser, "ยืนยัน")).status, 200);
    assert.equal((await pool.query("select count(*)::int as count from bookings")).rows[0].count, 1);

    const adminSessionRoute = require("../app/api/admin/session/route");
    const login = await adminSessionRoute.POST(new globalThis.Request("http://localhost/api/admin/session", { method: "POST",
      headers: { "user-agent": "integration-admin" }, body: JSON.stringify({ password: "integration-admin-password" }) }));
    assert.equal(login.status, 200); const adminCookie = login.headers.get("set-cookie").split(";")[0];
    const handoffRoute = require("../app/api/admin/handoffs/route");
    assert.equal((await handoffRoute.GET(new globalThis.Request("http://localhost/api/admin/handoffs"))).status, 403);
    const listed = await handoffRoute.GET(new globalThis.Request("http://localhost/api/admin/handoffs", { headers: { cookie: adminCookie } }));
    assert.equal(listed.status, 200); assert.equal((await listed.json()).data.handoffs.length, 1);
    const handoffUpdate = require("../app/api/admin/handoffs/[id]/route");
    const accepted = await handoffUpdate.PATCH(new globalThis.Request("http://localhost/api/admin/handoffs/id", { method: "PATCH",
      headers: { cookie: adminCookie }, body: JSON.stringify({ status: "accepted" }) }), { params: { id: handoffs[0].id } });
    assert.equal(accepted.status, 200);
    const logout = await adminSessionRoute.DELETE(new globalThis.Request("http://localhost/api/admin/session", { method: "DELETE", headers: { cookie: adminCookie } }));
    assert.equal(logout.status, 200);
    assert.equal((await adminSessionRoute.GET(new globalThis.Request("http://localhost/api/admin/session", { headers: { cookie: adminCookie } }))).status, 403);

    const health = require("../app/api/health/route");
    const healthResponse = await health.GET(); assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).database, "ready");
  } finally {
    globalThis.fetch = originalFetch;
    require("../src/ai/runtime").resetAIRuntime();
    delete process.env.LINE_ENABLED; delete process.env.LINE_CHANNEL_SECRET; delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    await pool.end();
  }
});

const ids = {
  cut: "11111111-1111-4111-8111-111111111111",
  color: "22222222-2222-4222-8222-222222222222",
  ann: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mean: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
};

async function resetDatabase(pool) {
  const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(schemaSql);
}

async function seedDeterministicData(pool) {
  await pool.query(
    `
      insert into services (id, name, description, duration_minutes, price) values
      ($1, 'Cut', 'Cut and style', 60, 500),
      ($2, 'Color', 'Basic color', 120, 1500)
    `,
    [ids.cut, ids.color]
  );
  await pool.query(
    `
      insert into staff (id, name, phone) values
      ($1, 'Ann', '0800000001'),
      ($2, 'Mean', '0800000002')
    `,
    [ids.ann, ids.mean]
  );
  await pool.query(
    `
      insert into staff_services (staff_id, service_id) values
      ($1, $2),
      ($1, $3),
      ($4, $2)
    `,
    [ids.ann, ids.cut, ids.color, ids.mean]
  );
  await pool.query(
    `
      insert into availability (staff_id, start_at, end_at, type, note) values
      ($1, '2026-09-10T10:00:00+07:00'::timestamptz, '2026-09-10T18:00:00+07:00'::timestamptz, 'available', 'working hours'),
      ($1, '2026-09-10T12:00:00+07:00'::timestamptz, '2026-09-10T13:00:00+07:00'::timestamptz, 'blocked', 'lunch break'),
      ($2, '2026-09-10T10:00:00+07:00'::timestamptz, '2026-09-10T14:00:00+07:00'::timestamptz, 'available', 'working hours')
    `,
    [ids.ann, ids.mean]
  );
}
