// Salon Booking OS v1 - Payment Phase J Test Suite
// Covers:
// 1. Manual review lifecycle: payment enters manual_review, staff approves or rejects
// 2. Atomic approval safety: lock payment, lock booking, payment->paid, booking->confirmed, history, event, outbox
// 3. Rejection: payment->verification_failed, booking pending for retry, audit preserved, attempts preserved
// 4. Duplicate idempotency: approve/reject twice has no duplicate side effects
// 5. Concurrency safety: concurrent approves under transaction execute side effects once
// 6. Slot safety: expired booking cannot be approved (MANUAL_REVIEW_LATE_PAYMENT)
// 7. Slot safety: overlapping active booking prevents approval and slot reclaim
// 8. Admin Queue & Review Details data safety: account masking, transRef fingerprinting, no secret exposure
// 9. LINE UX messaging: "ได้รับข้อมูลการชำระเงินแล้วค่ะ กำลังรอร้านตรวจสอบและยืนยันการจอง"
// 10. Admin Notification: payment_review_required outbox job created on manual_review
// 11. PostgreSQL Live Integration: real Docker PostgreSQL SELECT FOR UPDATE, atomic approval, rollback, idempotency

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { promises: fs } = require("node:fs");
const path = require("node:path");

const {
  PAYMENT_STATUSES,
  PAYMENT_REASON_CODES,
  SlipIntakeService,
  approvePaymentReview,
  rejectPaymentReview,
  getPaymentReviewDetails,
  PaymentReviewError,
  computeTransRefFingerprint,
  maskAccountNumber
} = require("../src/payment");

const { FakeRepository, buildSeed } = require("./fake-repository");
const { formatSlipReply } = require("../src/messaging/line-webhook-service");

// Helper: generate dummy base64 slip image
const DUMMY_SLIP_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

class MockContentProvider {
  constructor(buffer = DUMMY_SLIP_IMAGE) {
    this.buffer = buffer;
  }
  async getImageContent() {
    return {
      buffer: this.buffer,
      contentType: "image/png",
      contentLength: this.buffer.length
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Payment Enters manual_review & Enqueues Admin Notification
// ---------------------------------------------------------------------------

test("Phase J: payment entering manual_review enqueues payment_review_required outbox job idempotently", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    business_id: "default",
    service_id: "svc-cut",
    staff_id: "staff-ann",
    customer_id: "cust-1",
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    business_id: "default",
    original_booking_id: booking.id,
    payment_type: "deposit_fixed",
    provider: "manual_bank_transfer",
    amount_due: 200,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.pending,
    idempotency_key: `pay_${booking.id}`,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment);

  // Provide mock non-authoritative provider that returns success verification
  const nonAuthoritativeProvider = {
    providerName: "easyslip_v2",
    isAuthoritative: () => false,
    verifySlip: async () => ({
      success: true,
      provider: "easyslip_v2",
      normalized_result: "success",
      verified_amount: 200,
      amountSatang: 20000,
      verified_receiver: "0812345678",
      verified_transaction_reference: "TXN123456789",
      transactionReference: "TXN123456789",
      verified_transaction_at: new Date().toISOString()
    })
  };

  const intakeResult = await SlipIntakeService.processSlip({
    repository: repo,
    session: { paymentId: payment.id, stage: "payment_pending" },
    slipProvider: nonAuthoritativeProvider,
    contentProvider: new MockContentProvider(),
    entitlements: { slipVerification: true, autoPaymentConfirmation: false },
    expectedReceiver: { promptpayId: "0812345678" }
  });

  assert.equal(intakeResult.stage, "payment_manual_review");
  const updatedPayment = await repo.getPaymentById(payment.id);
  assert.equal(updatedPayment.status, PAYMENT_STATUSES.manualReview);

  // Check that admin outbox job was enqueued
  const reviewJob = repo.automationJobs.find(
    (j) => j.automation_type === "payment_review_required" && j.booking_id === booking.id
  );
  assert.ok(reviewJob, "Must enqueue payment_review_required outbox job");
  assert.equal(reviewJob.payload.payment_id, payment.id);
  assert.equal(reviewJob.event_key, `payment-review-required:${payment.id}`);
});

// ---------------------------------------------------------------------------
// 2. Atomic Approval Workflow
// ---------------------------------------------------------------------------

test("Phase J: approvePaymentReview performs atomic confirmation with all audit records", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    business_id: "default",
    service_id: "svc-cut",
    staff_id: "staff-ann",
    customer_id: "cust-1",
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    business_id: "default",
    original_booking_id: booking.id,
    payment_type: "deposit_fixed",
    provider: "manual_bank_transfer",
    amount_due: 200,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.manualReview,
    idempotency_key: `pay_${booking.id}`,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment);

  // Add payment attempt evidence
  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 200,
    verified_receiver: "0812345678",
    verified_transaction_reference: "TXN_REVIEW_001",
    verified_transaction_at: new Date().toISOString()
  });

  const approval = await approvePaymentReview(repo, {
    paymentId: payment.id,
    reviewedBy: "admin_staff_ann",
    notes: "Slip verified in bank statement"
  });

  assert.equal(approval.status, "approved");
  assert.equal(approval.idempotent, false);

  // 1. Payment status -> paid
  const savedPayment = await repo.getPaymentById(payment.id);
  assert.equal(savedPayment.status, PAYMENT_STATUSES.paid);
  assert.equal(savedPayment.review_status, "approved");
  assert.equal(savedPayment.reviewed_by, "admin_staff_ann");
  assert.equal(savedPayment.amount_paid, 200);

  // 2. Booking status -> confirmed
  const savedBooking = await repo.getBookingById(booking.id);
  assert.equal(savedBooking.status, "confirmed");

  // 3. Booking status history recorded
  const history = repo.bookingStatusHistory.find(
    (h) => h.booking_id === booking.id && h.to_status === "confirmed"
  );
  assert.ok(history, "Booking status history must be inserted");
  assert.equal(history.changed_by, "admin_staff_ann");
  assert.equal(history.reason, "staff_manual_approval");

  // 4. Payment event recorded
  const event = repo.paymentEvents.find(
    (e) => e.payment_id === payment.id && e.event_type === "payment_confirmed"
  );
  assert.ok(event, "Payment event must be inserted");
  assert.equal(event.actor, "admin_staff_ann");
  assert.equal(event.metadata.source_of_confirmation, "staff_manual_review");

  // 5. Outbox job created for booking confirmation
  const outboxJob = repo.automationJobs.find(
    (j) => j.automation_type === "booking_confirmation" && j.booking_id === booking.id
  );
  assert.ok(outboxJob, "Outbox confirmation job must be created");
  assert.equal(outboxJob.payload.source_of_confirmation, "staff_manual_review");
});

// ---------------------------------------------------------------------------
// 3. Rejection Workflow
// ---------------------------------------------------------------------------

test("Phase J: rejectPaymentReview transitions payment to verification_failed and preserves evidence", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    business_id: "default",
    service_id: "svc-cut",
    staff_id: "staff-ann",
    customer_id: "cust-1",
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    business_id: "default",
    original_booking_id: booking.id,
    payment_type: "deposit_fixed",
    provider: "manual_bank_transfer",
    amount_due: 200,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.manualReview,
    idempotency_key: `pay_${booking.id}`,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "receiver_mismatch",
    verified_amount: 200,
    verified_receiver: "0899999999",
    failure_reason_code: "RECEIVER_MISMATCH"
  });

  const rejection = await rejectPaymentReview(repo, {
    paymentId: payment.id,
    reviewedBy: "admin_staff_ann",
    reasonCode: "RECEIVER_MISMATCH",
    notes: "Wrong bank account transferred"
  });

  assert.equal(rejection.status, "rejected");
  assert.equal(rejection.idempotent, false);

  // Payment transitioned to verification_failed
  const savedPayment = await repo.getPaymentById(payment.id);
  assert.equal(savedPayment.status, PAYMENT_STATUSES.verificationFailed);
  assert.equal(savedPayment.review_status, "rejected");
  assert.equal(savedPayment.reviewed_by, "admin_staff_ann");

  // Booking remains pending so customer can re-upload within payment window
  const savedBooking = await repo.getBookingById(booking.id);
  assert.equal(savedBooking.status, "pending");

  // Payment attempts evidence is NOT deleted
  const attempts = await repo.getPaymentAttempts(payment.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].normalized_result, "receiver_mismatch");

  // Customer notification outbox job enqueued
  const rejectJob = repo.automationJobs.find(
    (j) => j.automation_type === "payment_review_rejected" && j.booking_id === booking.id
  );
  assert.ok(rejectJob, "payment_review_rejected outbox job must be enqueued");
  assert.equal(rejectJob.payload.reason_code, "RECEIVER_MISMATCH");
});

// ---------------------------------------------------------------------------
// 4. Duplicate Approve & Reject Idempotency
// ---------------------------------------------------------------------------

test("Phase J: duplicate approve is strictly idempotent and does not create duplicate events or jobs", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00",
    staff_id: "staff-ann"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    original_booking_id: booking.id,
    amount_due: 300,
    amount_paid: 0,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    idempotency_key: `pay_${booking.id}`
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 300
  });

  // First approval
  const res1 = await approvePaymentReview(repo, {
    paymentId: payment.id,
    reviewedBy: "admin_1"
  });
  assert.equal(res1.status, "approved");
  assert.equal(res1.idempotent, false);

  const eventCountFirst = repo.paymentEvents.length;
  const historyCountFirst = repo.bookingStatusHistory.length;
  const jobsCountFirst = repo.automationJobs.length;

  // Second duplicate approval
  const res2 = await approvePaymentReview(repo, {
    paymentId: payment.id,
    reviewedBy: "admin_1"
  });
  assert.equal(res2.status, "already_approved");
  assert.equal(res2.idempotent, true);

  // Side effects must NOT increase
  assert.equal(repo.paymentEvents.length, eventCountFirst);
  assert.equal(repo.bookingStatusHistory.length, historyCountFirst);
  assert.equal(repo.automationJobs.length, jobsCountFirst);
});

test("Phase J: duplicate reject is strictly idempotent", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = { id: randomUUID(), status: "pending" };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    original_booking_id: booking.id,
    amount_due: 300,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    idempotency_key: `pay_${booking.id}`
  };
  repo.payments.push(payment);

  const res1 = await rejectPaymentReview(repo, { paymentId: payment.id, reviewedBy: "admin_1" });
  assert.equal(res1.status, "rejected");
  assert.equal(res1.idempotent, false);

  const res2 = await rejectPaymentReview(repo, { paymentId: payment.id, reviewedBy: "admin_1" });
  assert.equal(res2.status, "already_rejected");
  assert.equal(res2.idempotent, true);
});

// ---------------------------------------------------------------------------
// 5. Slot Safety & Late Payment Guard
// ---------------------------------------------------------------------------

test("Phase J: approvePaymentReview rejects safely if booking has expired (MANUAL_REVIEW_LATE_PAYMENT)", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    status: "expired", // Booking already expired
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00",
    staff_id: "staff-ann"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    original_booking_id: booking.id,
    amount_due: 300,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString(),
    idempotency_key: `pay_${booking.id}`
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 300
  });

  await assert.rejects(
    () => approvePaymentReview(repo, { paymentId: payment.id, reviewedBy: "admin_1" }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "MANUAL_REVIEW_LATE_PAYMENT");
      return true;
    }
  );

  // Invariant: Expired booking remains expired
  const savedBooking = await repo.getBookingById(booking.id);
  assert.equal(savedBooking.status, "expired");
});

test("Phase J: approvePaymentReview blocks confirmation if slot was claimed by another booking", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  // Original booking A that was pending
  const bookingA = {
    id: randomUUID(),
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00",
    staff_id: "staff-ann"
  };
  repo.bookings.push(bookingA);

  // Conflicting booking B that already claimed the slot
  const bookingB = {
    id: randomUUID(),
    status: "confirmed",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00",
    staff_id: "staff-ann"
  };
  repo.bookings.push(bookingB);

  const payment = {
    id: randomUUID(),
    original_booking_id: bookingA.id,
    amount_due: 300,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    idempotency_key: `pay_${bookingA.id}`
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 300
  });

  await assert.rejects(
    () => approvePaymentReview(repo, { paymentId: payment.id, reviewedBy: "admin_1" }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "MANUAL_REVIEW_LATE_PAYMENT");
      return true;
    }
  );

  // Invariant: Booking B is untouched and booking A is NOT confirmed
  assert.equal((await repo.getBookingById(bookingA.id)).status, "pending");
  assert.equal((await repo.getBookingById(bookingB.id)).status, "confirmed");
});

// ---------------------------------------------------------------------------
// 6. Data Safety & Review Details Sanitization
// ---------------------------------------------------------------------------

test("Phase J: getPaymentReviewDetails returns masked, fingerprint-only sanitized data", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    status: "pending",
    start_at: "2026-09-15T10:00:00+07:00",
    end_at: "2026-09-15T11:00:00+07:00"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    original_booking_id: booking.id,
    amount_due: 500,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.manualReview,
    provider: "manual_bank_transfer",
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    idempotency_key: `pay_${booking.id}`
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 500,
    verified_receiver: "0812345678",
    verified_sender: "1234567890",
    verified_transaction_reference: "TXN_VERY_LONG_SECRET_123456",
    verified_transaction_at: "2026-09-15T09:55:00.000Z"
  });

  const detail = await getPaymentReviewDetails(repo, { paymentId: payment.id });

  // 1. Check transRef fingerprint
  assert.ok(detail.evidence.trans_ref_fingerprint);
  assert.ok(!detail.evidence.trans_ref_fingerprint.includes("VERY_LONG_SECRET"));
  assert.equal(detail.evidence.amount_match, true);
  assert.equal(detail.evidence.receiver_match_status, "MATCH");

  // 2. Check accounts in attempts are masked
  assert.equal(detail.attempts[0].verified_receiver, "081-xxx-678");
  assert.equal(detail.attempts[0].verified_sender, "123-xxx-890");
  assert.ok(!detail.attempts[0].trans_ref_fingerprint.includes("VERY_LONG_SECRET"));
});

// ---------------------------------------------------------------------------
// 7. LINE Customer UX Formatter
// ---------------------------------------------------------------------------

test("Phase J: LINE UX returns designated manual review notice for customers", () => {
  const reply = formatSlipReply(
    { stage: "payment_manual_review", code: "NON_AUTHORITATIVE_MANUAL_REVIEW" },
    { booking: { id: randomUUID() } },
    { hasFlex: false }
  );

  assert.equal(reply.type, "text");
  assert.ok(reply.text.includes("ได้รับข้อมูลการชำระเงินแล้วค่ะ"));
  assert.ok(reply.text.includes("กำลังรอร้านตรวจสอบและยืนยันการจอง"));
});

// ---------------------------------------------------------------------------
// 8. Live PostgreSQL Integration (Docker TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

const shouldRunPostgres = Boolean(process.env.TEST_DATABASE_URL);

test("Phase J: PostgreSQL Live Integration - atomic manual review approval and rollback", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");

  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repo = new PgBookingRepository({ pool });

  try {
    // 1. Ensure migrations are applied to test db
    const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const migration004 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "004_automation_jobs.sql"), "utf8");
    const migration005 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "005_automation_retry.sql"), "utf8");
    const migration007 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "007_payment_schema.sql"), "utf8");

    await pool.query("drop schema public cascade; create schema public;");
    await pool.query(schemaSql);
    await pool.query(migration004);
    await pool.query(migration005);
    await pool.query(migration007);

    // 2. Insert test fixtures: service, staff, customer, booking, payment
    const serviceId = randomUUID();
    const staffId = randomUUID();
    const customerId = randomUUID();
    const bookingId = randomUUID();
    const paymentId = randomUUID();

    await pool.query(
      "insert into services (id, name, duration_minutes, price) values ($1, 'Haircut', 60, 500)",
      [serviceId]
    );
    await pool.query(
      "insert into staff (id, name) values ($1, 'Stylist A')",
      [staffId]
    );
    await pool.query(
      "insert into customers (id, name, phone) values ($1, 'Test Cust', '0812345678')",
      [customerId]
    );
    await pool.query(
      `
        insert into bookings (id, service_id, staff_id, customer_id, start_at, end_at, status)
        values ($1, $2, $3, $4, '2026-09-20T10:00:00+07:00', '2026-09-20T11:00:00+07:00', 'pending')
      `,
      [bookingId, serviceId, staffId, customerId]
    );

    await repo.createPayment({
      id: paymentId,
      original_booking_id: bookingId,
      payment_type: "deposit_fixed",
      provider: "manual_bank_transfer",
      amount_due: 200,
      amount_paid: 0,
      currency: "THB",
      status: PAYMENT_STATUSES.manualReview,
      idempotency_key: `pay_pg_${paymentId}`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

    await repo.createPaymentAttempt({
      payment_id: paymentId,
      attempt_type: "slip_upload",
      verification_provider: "easyslip_v2",
      normalized_result: "success",
      verified_amount: 200,
      verified_receiver: "0812345678",
      verified_transaction_reference: "PG_TXN_001"
    });

    // 3. Test listPaymentsForManualReview query on real Postgres
    const queue = await repo.listPaymentsForManualReview();
    assert.ok(queue.length >= 1);
    assert.equal(queue[0].payment_id, paymentId);
    assert.equal(queue[0].customer_name, "Test Cust");

    // 4. Test atomic approval on real Postgres
    const approval = await approvePaymentReview(repo, {
      paymentId,
      reviewedBy: "pg_admin_reviewer",
      notes: "Postgres live trial approval"
    });

    assert.equal(approval.status, "approved");
    assert.equal(approval.payment.status, PAYMENT_STATUSES.paid);
    assert.equal(approval.payment.review_status, "approved");
    assert.equal(approval.payment.reviewed_by, "pg_admin_reviewer");

    const savedBookingRes = await pool.query("select status from bookings where id = $1", [bookingId]);
    assert.equal(savedBookingRes.rows[0].status, "confirmed");

    const historyRes = await pool.query("select * from booking_status_history where booking_id = $1", [bookingId]);
    assert.ok(historyRes.rows.length >= 1);
    assert.equal(historyRes.rows[0].changed_by, "pg_admin_reviewer");

    // 5. Test idempotency on real Postgres
    const repeatApproval = await approvePaymentReview(repo, {
      paymentId,
      reviewedBy: "pg_admin_reviewer"
    });
    assert.equal(repeatApproval.status, "already_approved");
    assert.equal(repeatApproval.idempotent, true);

    // 6. Test Rollback on Failure
    const failingBookingId = randomUUID();
    const failingPaymentId = randomUUID();
    await pool.query(
      `
        insert into bookings (id, service_id, staff_id, customer_id, start_at, end_at, status)
        values ($1, $2, $3, $4, '2026-09-21T14:00:00+07:00', '2026-09-21T15:00:00+07:00', 'pending')
      `,
      [failingBookingId, serviceId, staffId, customerId]
    );
    await repo.createPayment({
      id: failingPaymentId,
      original_booking_id: failingBookingId,
      payment_type: "deposit_fixed",
      provider: "manual_bank_transfer",
      amount_due: 200,
      amount_paid: 0,
      currency: "THB",
      status: PAYMENT_STATUSES.manualReview,
      idempotency_key: `pay_pg_fail_${failingPaymentId}`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });

    await repo.createPaymentAttempt({
      payment_id: failingPaymentId,
      attempt_type: "slip_upload",
      verification_provider: "easyslip_v2",
      normalized_result: "success",
      verified_amount: 200,
      verified_receiver: "0812345678",
      verified_transaction_reference: "PG_TXN_FAIL_001"
    });

    // Attempt approval with repo where enqueueAutomationJob fails
    const failingRepo = new PgBookingRepository({ pool });
    failingRepo._overrides = {
      enqueueAutomationJob: async () => {
        throw new Error("Simulated outbox enqueue failure");
      }
    };

    await assert.rejects(
      () => approvePaymentReview(failingRepo, { paymentId: failingPaymentId, reviewedBy: "admin_failing" }),
      /Simulated outbox enqueue failure/
    );

    // Verify rollback: payment must still be manual_review, booking still pending
    const rollbackPaymentRes = await pool.query("select status from payments where id = $1", [failingPaymentId]);
    assert.equal(rollbackPaymentRes.rows[0].status, PAYMENT_STATUSES.manualReview);
    const rollbackBookingRes = await pool.query("select status from bookings where id = $1", [failingBookingId]);
    assert.equal(rollbackBookingRes.rows[0].status, "pending");

    // 7. Test Concurrency on real Postgres (Simultaneous approvals under lock)
    const concBookingId = randomUUID();
    const concPaymentId = randomUUID();
    await pool.query(
      `
        insert into bookings (id, service_id, staff_id, customer_id, start_at, end_at, status)
        values ($1, $2, $3, $4, '2026-09-22T10:00:00+07:00', '2026-09-22T11:00:00+07:00', 'pending')
      `,
      [concBookingId, serviceId, staffId, customerId]
    );
    await repo.createPayment({
      id: concPaymentId,
      original_booking_id: concBookingId,
      payment_type: "deposit_fixed",
      provider: "manual_bank_transfer",
      amount_due: 200,
      amount_paid: 0,
      currency: "THB",
      status: PAYMENT_STATUSES.manualReview,
      idempotency_key: `pay_pg_conc_${concPaymentId}`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });
    await repo.createPaymentAttempt({
      payment_id: concPaymentId,
      attempt_type: "slip_upload",
      verification_provider: "easyslip_v2",
      normalized_result: "success",
      verified_amount: 200,
      verified_receiver: "0812345678",
      verified_transaction_reference: "PG_TXN_CONC"
    });

    const [concRes1, concRes2] = await Promise.all([
      approvePaymentReview(repo, { paymentId: concPaymentId, reviewedBy: "admin_conc_1" }),
      approvePaymentReview(repo, { paymentId: concPaymentId, reviewedBy: "admin_conc_2" })
    ]);

    // Exactly one must be "approved" and the other "already_approved"
    const statuses = [concRes1.status, concRes2.status].sort();
    assert.deepEqual(statuses, ["already_approved", "approved"]);

    // Exactly 1 booking status history for confirmation
    const concHistRes = await pool.query("select * from booking_status_history where booking_id = $1 and to_status = 'confirmed'", [concBookingId]);
    assert.equal(concHistRes.rows.length, 1);
  } finally {
    await pool.end();
  }
});

test("Phase J: Admin API requires authorization and rejects unauthorized callers", async () => {
  const { GET: paymentsGet } = require("../app/api/admin/payments/route");
  const { POST: reviewPost } = require("../app/api/admin/payments/[id]/review/route");

  // Call GET without cookie
  const unauthGetReq = new Request("http://localhost/api/admin/payments", { method: "GET" });
  const getRes = await paymentsGet(unauthGetReq);
  assert.equal(getRes.status, 403);

  // Call POST without cookie
  const unauthPostReq = new Request("http://localhost/api/admin/payments/pay-123/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  const postRes = await reviewPost(unauthPostReq, { params: Promise.resolve({ id: "pay-123" }) });
  assert.equal(postRes.status, 403);
});

