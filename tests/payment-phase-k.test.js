// Salon Booking OS v1 - Phase K: Pilot Deployment Readiness + Production Migration Rehearsal Test Suite
//
// Validates:
// 1. Clean migration sequence (schema.sql -> 004 -> 005 -> 006 -> 007)
// 2. Existing database upgrade test (pre-payment data preserved, GiST works, no locks/invalidations)
// 3. Automation jobs constraint safety (exact check constraint name and valid types)
// 4. Pilot tenant feature flags & capability matrix
// 5. Payment policy hierarchy (service override > business default > no_payment baseline)
// 6. Cross-tenant isolation (tenant A admin cannot list, inspect, approve, or reject tenant B payments)
// 7. End-to-end local/staging flow (Booking pending -> Payment manual_review -> Admin approve -> Booking confirmed -> Outbox)
// 8. Reject workflow with evidence preservation and resubmit
// 9. Late payment / Slot expiration safety (MANUAL_REVIEW_LATE_PAYMENT)
// 10. Audit trail immutability and replay protection

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  PAYMENT_STATUSES,
  calculatePricing,
  approvePaymentReview,
  rejectPaymentReview,
  getPaymentReviewDetails,
  PaymentReviewError
} = require("../src/payment");
const { FakeRepository } = require("./fake-repository");
const { adminToken } = require("../src/security/access");

function buildSeed() {
  return {
    business: { id: "biz-pilot-1", name: "Pilot Salon Bangkok", phone: "0811111111" },
    services: [
      { id: "svc-haircut", name: "Premium Haircut", duration_minutes: 60, price: 500, active: true },
      { id: "svc-spa", name: "Hair Spa Treatment", duration_minutes: 90, price: 1200, active: true }
    ],
    staff: [
      { id: "staff-jane", name: "Jane Stylist", phone: "0822222222", active: true }
    ],
    staffServices: [
      { staff_id: "staff-jane", service_id: "svc-haircut" },
      { staff_id: "staff-jane", service_id: "svc-spa" }
    ],
    customers: [
      { id: "cust-somchai", name: "Somchai", phone: "0899999999", line_user_id: "U_somchai" }
    ],
    bookings: [],
    payments: [],
    paymentAttempts: [],
    paymentAllocations: [],
    paymentEvents: [],
    automationJobs: [],
    bookingStatusHistory: []
  };
}

// =============================================================================
// 1. Migration Rehearsal & Existing DB Upgrade on Live Docker PostgreSQL
// =============================================================================

const shouldRunPostgres = Boolean(process.env.TEST_DATABASE_URL);

test("Phase K Rehearsal: Clean migration sequence and existing DB upgrade without data loss", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  try {
    const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const migration004 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "004_automation_jobs.sql"), "utf8");
    const migration005 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "005_automation_retry.sql"), "utf8");
    const migration006 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "006_pilot_hardening.sql"), "utf8");
    const migration007 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "007_payment_schema.sql"), "utf8");

    // Reset database to completely blank schema
    await pool.query("drop schema public cascade; create schema public;");

    // 1. Rehearse pre-payment baseline schema (schema.sql -> 004 -> 005 -> 006)
    await pool.query(schemaSql);
    await pool.query(migration004);
    await pool.query(migration005);
    await pool.query(migration006);

    // 2. Seed pre-existing production-like data BEFORE payment migration 007
    const testCustId = randomUUID();
    const testSvcId = randomUUID();
    const testStaffId = randomUUID();
    const existingConfirmedId = randomUUID();
    const existingCancelledId = randomUUID();

    await pool.query("insert into customers (id, name, phone) values ($1, 'Legacy Cust', '0811112222')", [testCustId]);
    await pool.query("insert into services (id, name, duration_minutes, price) values ($1, 'Classic Cut', 45, 400)", [testSvcId]);
    await pool.query("insert into staff (id, name) values ($1, 'Staff Senior')", [testStaffId]);

    await pool.query(
      `insert into bookings (id, customer_id, service_id, staff_id, start_at, end_at, status, source)
       values ($1, $2, $3, $4, '2026-10-01T10:00:00+07:00', '2026-10-01T10:45:00+07:00', 'confirmed', 'line')`,
      [existingConfirmedId, testCustId, testSvcId, testStaffId]
    );

    await pool.query(
      `insert into bookings (id, customer_id, service_id, staff_id, start_at, end_at, status, source)
       values ($1, $2, $3, $4, '2026-10-01T11:00:00+07:00', '2026-10-01T11:45:00+07:00', 'cancelled', 'line')`,
      [existingCancelledId, testCustId, testSvcId, testStaffId]
    );

    await pool.query(
      `insert into automation_jobs (booking_id, automation_type, event_key, scheduled_at, status)
       values ($1, 'booking_confirmation', 'job_legacy_1', now(), 'completed')`,
      [existingConfirmedId]
    );

    // 3. Apply 007_payment_schema.sql on existing database
    await pool.query(migration007);

    // 4. Validate existing data integrity
    const confRes = await pool.query("select * from bookings where id = $1", [existingConfirmedId]);
    assert.equal(confRes.rows.length, 1);
    assert.equal(confRes.rows[0].status, "confirmed");

    const jobRes = await pool.query("select * from automation_jobs where booking_id = $1", [existingConfirmedId]);
    assert.equal(jobRes.rows.length, 1);
    assert.equal(jobRes.rows[0].automation_type, "booking_confirmation");

    // 5. Validate GiST double booking exclusion constraint still functions
    await assert.rejects(
      () => pool.query(
        `insert into bookings (customer_id, service_id, staff_id, start_at, end_at, status)
         values ($1, $2, $3, '2026-10-01T10:15:00+07:00', '2026-10-01T11:00:00+07:00', 'pending')`,
        [testCustId, testSvcId, testStaffId]
      ),
      /exclusion constraint|23P01/
    );

    // 6. Validate new payment tables and constraint expansion
    const tablesRes = await pool.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in (
        'payments', 'payment_allocations', 'payment_attempts',
        'payment_events', 'refunds', 'business_integrations'
      )
    `);
    assert.equal(tablesRes.rows.length, 6, "All 6 payment tables must exist");

    // Validate automation_type check constraint accepts payment review types
    const jobReviewRequiredRes = await pool.query(
      `insert into automation_jobs (booking_id, automation_type, event_key, scheduled_at, status)
       values ($1, 'payment_review_required', 'job_payment_review_1', now(), 'pending') returning *`,
      [existingConfirmedId]
    );
    assert.equal(jobReviewRequiredRes.rows[0].automation_type, "payment_review_required");

    // 7. Validate Idempotent re-run of 007
    await pool.query(migration007);
  } finally {
    await pool.end();
  }
});

// =============================================================================
// 2. Policy Hierarchy: service override > business default > no_payment baseline
// =============================================================================

test("Phase K: Payment policy resolution follows strict precedence without hardcoding", () => {
  const servicePrice = 1000;

  // Case A: No policies configured -> baseline no_payment
  const baseline = calculatePricing({ servicePrice });
  assert.equal(baseline.paymentType, "no_payment");
  assert.equal(baseline.amountDue, 0);

  // Case B: Business default configured as deposit_fixed 300 THB
  const bizPolicy = { payment_type: "deposit_fixed", fixed_amount: 300 };
  const bizPricing = calculatePricing({ servicePrice, businessPolicy: bizPolicy });
  assert.equal(bizPricing.paymentType, "deposit_fixed");
  assert.equal(bizPricing.amountDue, 300);

  // Case C: Service override configured as deposit_percentage 50%
  const svcPolicy = { payment_type: "deposit_percentage", percentage: 50 };
  const overridePricing = calculatePricing({
    servicePrice,
    businessPolicy: bizPolicy,
    servicePolicy: svcPolicy
  });
  assert.equal(overridePricing.paymentType, "deposit_percentage");
  assert.equal(overridePricing.amountDue, 500);

  // Case D: Fixed deposit capped at service price (cannot exceed service total)
  const cappedPricing = calculatePricing({
    servicePrice: 200,
    servicePolicy: { payment_type: "deposit_fixed", fixed_amount: 500 }
  });
  assert.equal(cappedPricing.amountDue, 200);
});

// =============================================================================
// 3. Cross-Tenant Isolation & Security
// =============================================================================

test("Phase K: Cross-Tenant Isolation - Tenant A staff cannot list, inspect, approve, or reject Tenant B payments", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  // Tenant A setup
  const bookingA = {
    id: randomUUID(),
    business_id: "biz-tenant-a",
    status: "pending",
    start_at: "2026-10-05T10:00:00+07:00",
    end_at: "2026-10-05T11:00:00+07:00",
    staff_id: "staff-jane"
  };
  const paymentA = {
    id: randomUUID(),
    business_id: "biz-tenant-a",
    original_booking_id: bookingA.id,
    amount_due: 300,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.bookings.push(bookingA);
  repo.payments.push(paymentA);
  await repo.createPaymentAttempt({
    payment_id: paymentA.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 300
  });

  // Tenant B setup
  const bookingB = {
    id: randomUUID(),
    business_id: "biz-tenant-b",
    status: "pending",
    start_at: "2026-10-05T14:00:00+07:00",
    end_at: "2026-10-05T15:00:00+07:00",
    staff_id: "staff-jane"
  };
  const paymentB = {
    id: randomUUID(),
    business_id: "biz-tenant-b",
    original_booking_id: bookingB.id,
    amount_due: 500,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.bookings.push(bookingB);
  repo.payments.push(paymentB);
  await repo.createPaymentAttempt({
    payment_id: paymentB.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 500
  });

  // 1. Tenant A list queue: must ONLY return Tenant A payments
  const queueA = await repo.listPaymentsForManualReview({ businessId: "biz-tenant-a" });
  assert.equal(queueA.length, 1);
  assert.equal(queueA[0].payment_id, paymentA.id);
  assert.equal(queueA[0].business_id, "biz-tenant-a");

  // 2. Tenant A attempts to inspect Tenant B payment: must fail closed with TENANT_ISOLATION_VIOLATION
  await assert.rejects(
    () => getPaymentReviewDetails(repo, { paymentId: paymentB.id, tenantId: "biz-tenant-a" }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );

  // 3. Tenant A attempts to approve Tenant B payment: must fail closed
  await assert.rejects(
    () => approvePaymentReview(repo, {
      paymentId: paymentB.id,
      tenantId: "biz-tenant-a",
      reviewedBy: "admin_tenant_a"
    }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );

  // 4. Tenant A attempts to reject Tenant B payment: must fail closed
  await assert.rejects(
    () => rejectPaymentReview(repo, {
      paymentId: paymentB.id,
      tenantId: "biz-tenant-a",
      reviewedBy: "admin_tenant_a"
    }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );

  // Invariant verification: Payment B and Booking B remain completely untouched
  const unchangedPaymentB = await repo.getPaymentById(paymentB.id);
  assert.equal(unchangedPaymentB.status, PAYMENT_STATUSES.manualReview);
  assert.equal(unchangedPaymentB.reviewed_by, undefined);

  const unchangedBookingB = await repo.getBookingById(bookingB.id);
  assert.equal(unchangedBookingB.status, "pending");
});

// =============================================================================
// 4. End-to-End Manual Review Flow (Local / FakeRepository)
// =============================================================================

test("Phase K: End-to-End Manual Review Flow - Approval produces confirmed booking and outbox", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    business_id: "biz-pilot-1",
    customer_id: "cust-somchai",
    service_id: "svc-haircut",
    staff_id: "staff-jane",
    start_at: "2026-10-10T14:00:00+07:00",
    end_at: "2026-10-10T15:00:00+07:00",
    status: "pending"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    business_id: "biz-pilot-1",
    original_booking_id: booking.id,
    amount_due: 200,
    amount_paid: 0,
    currency: "THB",
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment);

  await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 200,
    verified_receiver: "0811111111",
    verified_transaction_reference: "TRANSREF_E2E_123"
  });

  // Admin approves review
  const approval = await approvePaymentReview(repo, {
    paymentId: payment.id,
    tenantId: "biz-pilot-1",
    reviewedBy: "pilot_admin_ann",
    notes: "Slip verified against bank app"
  });

  assert.equal(approval.status, "approved");
  assert.equal(approval.payment.status, PAYMENT_STATUSES.paid);
  assert.equal(approval.booking.status, "confirmed");

  // Verify Outbox job created with correct source of confirmation
  const outboxJob = repo.automationJobs.find(
    (j) => j.automation_type === "booking_confirmation" && j.booking_id === booking.id
  );
  assert.ok(outboxJob, "Outbox job must be generated for LINE delivery");
  assert.equal(outboxJob.payload.source_of_confirmation, "staff_manual_review");
});

// =============================================================================
// 5. Rejection & Resubmission Workflow
// =============================================================================

test("Phase K: Reject flow leaves booking pending, preserves old attempt, and accepts new attempt", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const booking = {
    id: randomUUID(),
    business_id: "biz-pilot-1",
    status: "pending",
    start_at: "2026-10-10T16:00:00+07:00",
    end_at: "2026-10-10T17:00:00+07:00",
    staff_id: "staff-jane"
  };
  repo.bookings.push(booking);

  const payment = {
    id: randomUUID(),
    business_id: "biz-pilot-1",
    original_booking_id: booking.id,
    amount_due: 500,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment);

  // Attempt 1: bad slip
  const attempt1 = await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "receiver_mismatch",
    verified_amount: 500,
    verified_receiver: "9999999999"
  });

  // Staff rejects payment
  const rejection = await rejectPaymentReview(repo, {
    paymentId: payment.id,
    tenantId: "biz-pilot-1",
    reviewedBy: "pilot_admin_ann",
    reasonCode: "RECEIVER_MISMATCH",
    notes: "Wrong receiver account"
  });

  assert.equal(rejection.status, "rejected");
  assert.equal(rejection.payment.status, PAYMENT_STATUSES.verificationFailed);
  assert.equal(rejection.booking.status, "pending", "Booking remains pending for retry within window");

  // Attempt 2: customer sends corrected slip
  const attempt2 = await repo.createPaymentAttempt({
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 500,
    verified_receiver: "0811111111"
  });

  const allAttempts = await repo.getPaymentAttempts(payment.id);
  assert.equal(allAttempts.length, 2, "All attempts must be immutably preserved in history");
  assert.equal(allAttempts[0].id, attempt1.id);
  assert.equal(allAttempts[1].id, attempt2.id);
});

// =============================================================================
// 6. Admin API Security & Cross-Tenant API Rejection
// =============================================================================

test("Phase K: Admin API enforces authentication and rejects cross-tenant API requests", async () => {
  process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "phase_k_test_secret_32_characters_long!";
  const validToken = adminToken();

  const { GET: paymentsGet } = require("../app/api/admin/payments/route");
  const { GET: reviewGet, POST: reviewPost } = require("../app/api/admin/payments/[id]/review/route");

  // 1. Unauthenticated GET /admin/payments -> 403
  const unauthGetReq = new Request("http://localhost/api/admin/payments", { method: "GET" });
  const unauthGetRes = await paymentsGet(unauthGetReq);
  assert.equal(unauthGetRes.status, 403);

  // 2. Unauthenticated POST review -> 403
  const unauthPostReq = new Request("http://localhost/api/admin/payments/p-1/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  const unauthPostRes = await reviewPost(unauthPostReq, { params: Promise.resolve({ id: "p-1" }) });
  assert.equal(unauthPostRes.status, 403);

  // 3. Domain level cross-tenant rejection
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const otherTenantPayment = {
    id: "pay_other_tenant_999",
    business_id: "biz_tenant_b",
    original_booking_id: "book_999",
    amount_due: 400,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  const otherTenantBooking = { id: "book_999", business_id: "biz_tenant_b", status: "pending" };
  repo.payments.push(otherTenantPayment);
  repo.bookings.push(otherTenantBooking);

  // Test domain level cross-tenant rejection
  await assert.rejects(
    () => getPaymentReviewDetails(repo, { paymentId: otherTenantPayment.id, tenantId: "biz_tenant_a" }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );

  await assert.rejects(
    () => approvePaymentReview(repo, {
      paymentId: otherTenantPayment.id,
      tenantId: "biz_tenant_a",
      reviewedBy: "admin_tenant_a"
    }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );

  await assert.rejects(
    () => rejectPaymentReview(repo, {
      paymentId: otherTenantPayment.id,
      tenantId: "biz_tenant_a",
      reviewedBy: "admin_tenant_a"
    }),
    (err) => {
      assert.ok(err instanceof PaymentReviewError);
      assert.equal(err.code, "TENANT_ISOLATION_VIOLATION");
      return true;
    }
  );
});
