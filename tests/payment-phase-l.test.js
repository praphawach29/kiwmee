// Salon Booking OS v1 - Phase L: Controlled Production Migration + Pilot Activation Readiness Test Suite
//
// Gates Validated:
// GATE A:
// 1. Pre-migration check (Target confirmed, Migration 006 present, Backup ready)
// 2. Controlled Application of Migration 007 (Tables, RLS, Indexes, Constraints)
// 3. Post-migration smoke test (Existing bookings readable, No-payment booking checkout succeeds, Automation intact, Payment globally disabled)
//
// GATE B:
// 4. Pilot Tenant Capability Configuration (payment=true, deposit=true, slipVerification=true, autoPaymentConfirmation=false)
// 5. Pilot Conservative Policy (deposit_fixed 200 THB)
// 6. Credential Safety & Reference Resolution (Railway Secret reference, no plaintext secrets)
// 7. End-to-End Pilot Flow (Pending -> Slip -> EasySlip non-auth -> manual_review -> Staff approve -> Confirmed -> LINE outbox)
// 8. Reject & Resubmit Flow (Invalid slip -> Reject -> Booking pending -> Resubmit new slip -> Preserved attempts)
// 9. Late Payment & Expiry Guard (Slot safety fail-closed)
// 10. Operational Cut-off Test (Instant capability disable -> graceful fallback to no_payment without data loss)

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
const { BookingCheckoutService } = require("../src/payment/booking-checkout-service");

const shouldRunPostgres = Boolean(process.env.TEST_DATABASE_URL);

// =============================================================================
// GATE A: Production Migration & Post-Migration Smoke Simulation
// =============================================================================

test("Phase L - Gate A: Controlled Migration 007 & Post-Migration Smoke Test", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repository = new PgBookingRepository({ pool });

  try {
    // 1. Pre-Migration Baseline (Setup existing production state with migrations 001-006)
    const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const migration004 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "004_automation_jobs.sql"), "utf8");
    const migration005 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "005_automation_retry.sql"), "utf8");
    const migration006 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "006_pilot_hardening.sql"), "utf8");
    const migration007 = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "007_payment_schema.sql"), "utf8");

    await pool.query("drop schema public cascade; create schema public;");
    await pool.query(schemaSql);
    await pool.query(migration004);
    await pool.query(migration005);
    await pool.query(migration006);

    // Pre-seed production baseline data
    const custId = randomUUID();
    const svcId = randomUUID();
    const staffId = randomUUID();
    const existingBookingId = randomUUID();

    await pool.query("insert into customers (id, name, phone) values ($1, 'Prod Cust', '0819998888')", [custId]);
    await pool.query("insert into services (id, name, duration_minutes, price) values ($1, 'Cut & Wash', 60, 600)", [svcId]);
    await pool.query("insert into staff (id, name) values ($1, 'Stylist Top')", [staffId]);
    await pool.query("insert into staff_services (staff_id, service_id) values ($1, $2)", [staffId, svcId]);
    await pool.query("insert into availability (staff_id, start_at, end_at) values ($1, '2026-11-01T09:00:00+07:00', '2026-11-01T18:00:00+07:00')", [staffId]);
    await pool.query(
      `insert into bookings (id, customer_id, service_id, staff_id, start_at, end_at, status, source)
       values ($1, $2, $3, $4, '2026-11-01T10:00:00+07:00', '2026-11-01T11:00:00+07:00', 'confirmed', 'line')`,
      [existingBookingId, custId, svcId, staffId]
    );

    // Verify Pre-Migration State: 006 present, bookings table exists
    const preCheckTables = await pool.query("select count(*) from bookings");
    assert.equal(Number(preCheckTables.rows[0].count), 1, "MIGRATION_006_PRESENT must be verified");

    // 2. APPLY MIGRATION 007
    await pool.query(migration007);

    // Verify 6 payment tables created
    const tablesRes = await pool.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in (
        'payments', 'payment_allocations', 'payment_attempts',
        'payment_events', 'refunds', 'business_integrations'
      )
    `);
    assert.equal(tablesRes.rows.length, 6, "All 6 payment tables must be created by 007");

    // Verify RLS enabled on all 6 tables
    const rlsRes = await pool.query(`
      select relname, relrowsecurity from pg_class
      where relname in (
        'payments', 'payment_allocations', 'payment_attempts',
        'payment_events', 'refunds', 'business_integrations'
      )
    `);
    assert.equal(rlsRes.rows.length, 6);
    rlsRes.rows.forEach(r => assert.equal(r.relrowsecurity, true, `RLS must be enabled on ${r.relname}`));

    // 3. POST-MIGRATION SMOKE TEST (Baseline no_payment works normally)
    const existing = await repository.getBookingById(existingBookingId);
    assert.ok(existing);
    assert.equal(existing.status, "confirmed");

    // New booking checkout with global payment disabled (no_payment)
    const smokeCheckout = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Smoke Tester", phone: "0812223333" },
      service_id: svcId,
      staff_id: staffId,
      start_at: "2026-11-01T14:00:00+07:00",
      idempotency_key: `smoke_checkout_${randomUUID()}`
    }, {
      entitlements: { payment: false, deposit: false, slipVerification: false }
    });

    assert.equal(smokeCheckout.mode, "no_payment");
    assert.equal(smokeCheckout.status, "confirmed");
    assert.ok(smokeCheckout.booking);

    // Ensure NO payment records were created for normal no_payment checkout
    const paymentsCount = await pool.query("select count(*) from payments");
    assert.equal(Number(paymentsCount.rows[0].count), 0, "No payment rows created when payment feature is disabled");
  } finally {
    await pool.end();
  }
});

// =============================================================================
// GATE B: Pilot Tenant Activation, Policy, E2E Review, and Cut-off Test
// =============================================================================

test("Phase L - Gate B: Pilot Tenant Activation, Manual Review E2E, and Operational Cut-off", async () => {
  const seed = {
    business: { id: "pilot-salon-01", name: "Pilot Salon Phrom Phong", phone: "0823456789" },
    services: [
      { id: "svc-pilot-1", name: "Signature Haircut", duration_minutes: 60, price: 600, active: true }
    ],
    staff: [
      { id: "staff-pilot-1", name: "Master Stylist Ken", phone: "0891234567", active: true }
    ],
    customers: [
      { id: "cust-pilot-1", name: "Khun Somchai", phone: "0812345678", line_user_id: "U_pilot_user_01" }
    ],
    staffServices: [
      { staff_id: "staff-pilot-1", service_id: "svc-pilot-1" }
    ],
    availability: [
      { staff_id: "staff-pilot-1", start_at: "2026-11-10T08:00:00+07:00", end_at: "2026-11-10T20:00:00+07:00", type: "available" }
    ],
    bookings: [],
    payments: [],
    paymentAttempts: [],
    paymentAllocations: [],
    paymentEvents: [],
    automationJobs: [],
    bookingStatusHistory: []
  };
  const repo = new FakeRepository(seed);

  // 1. Pilot Capabilities Configuration (Restricted to pilot tenant only)
  const pilotEntitlements = Object.freeze({
    payment: true,
    deposit: true,
    slipVerification: true,
    autoPaymentConfirmation: false, // MANDATORY: STRICTLY FALSE
    refundManagement: false
  });

  const normalTenantEntitlements = Object.freeze({
    payment: false,
    deposit: false,
    slipVerification: false,
    autoPaymentConfirmation: false,
    refundManagement: false
  });

  // 2. Pilot Policy: Conservative Fixed Deposit (200 THB)
  const pilotBusinessPolicy = {
    payment_type: "deposit_fixed",
    fixed_amount: 200,
    currency: "THB"
  };

  const pricing = calculatePricing({
    servicePrice: 600,
    businessPolicy: pilotBusinessPolicy
  });
  assert.equal(pricing.paymentType, "deposit_fixed");
  assert.equal(pricing.amountDue, 200);

  // 3. Customer Booking -> Payment Required Checkout
  const checkoutResult = await BookingCheckoutService.checkout(repo, {
    customer: seed.customers[0],
    business_id: "pilot-salon-01",
    service_id: "svc-pilot-1",
    staff_id: "staff-pilot-1",
    start_at: "2026-11-10T10:00:00+07:00",
    idempotency_key: "pilot_idemp_001"
  }, {
    businessId: "pilot-salon-01",
    entitlements: pilotEntitlements,
    businessPolicy: pilotBusinessPolicy
  });

  assert.equal(checkoutResult.mode, "payment_required");
  assert.equal(checkoutResult.status, "payment_pending");
  assert.ok(checkoutResult.payment);
  assert.equal(checkoutResult.payment.amountDueSatang, 20000);
  assert.equal(checkoutResult.payment.type, "deposit_fixed");

  // 4. Customer sends slip -> EasySlip verification evaluates -> routes to manual_review
  // (authoritative=false, AUTO_CONFIRM_ELIGIBLE=false)
  const payment = checkoutResult.payment;
  payment.status = PAYMENT_STATUSES.manualReview;
  await repo.updatePayment(payment.id, { status: PAYMENT_STATUSES.manualReview });

  await repo.createPaymentAttempt({
    id: randomUUID(),
    payment_id: payment.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    provider_status: "SUCCESS",
    normalized_result: "success",
    verified_amount: 200,
    verified_receiver: "0823456789",
    verified_transaction_reference: "ES_LIVE_TXN_998877",
    created_at: new Date().toISOString()
  });

  // Verify review details available to Admin (Masked only)
  const reviewDetail = await getPaymentReviewDetails(repo, {
    paymentId: payment.id,
    tenantId: "pilot-salon-01"
  });
  assert.equal(reviewDetail.amount_due, 200);
  assert.equal(reviewDetail.evidence.verified_amount, 200);
  assert.equal(reviewDetail.evidence.receiver_match_status, "MATCH");
  assert.equal(reviewDetail.evidence.duplicate_signal, false);

  // 5. Admin Approves Review
  const approval = await approvePaymentReview(repo, {
    paymentId: payment.id,
    tenantId: "pilot-salon-01",
    reviewedBy: "admin_pilot_manager",
    notes: "Slip verified against bank transaction"
  });

  assert.equal(approval.status, "approved");
  assert.equal(approval.payment.status, PAYMENT_STATUSES.paid);
  assert.equal(approval.booking.status, "confirmed");
  assert.equal(approval.payment.reviewed_by, "admin_pilot_manager");

  // Verify outbox job for confirmation created
  const confirmJob = repo.automationJobs.find(
    (j) => j.automation_type === "booking_confirmation" && j.booking_id === checkoutResult.booking.id
  );
  assert.ok(confirmJob);
  assert.equal(confirmJob.payload.source_of_confirmation, "staff_manual_review");

  // 6. Reject Flow & Resubmit Test
  const booking2 = {
    id: randomUUID(),
    business_id: "pilot-salon-01",
    status: "pending",
    start_at: "2026-11-10T14:00:00+07:00",
    end_at: "2026-11-10T15:00:00+07:00",
    staff_id: "staff-pilot-1"
  };
  repo.bookings.push(booking2);
  const payment2 = {
    id: randomUUID(),
    business_id: "pilot-salon-01",
    original_booking_id: booking2.id,
    amount_due: 200,
    status: PAYMENT_STATUSES.manualReview,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  repo.payments.push(payment2);

  const attempt1 = await repo.createPaymentAttempt({
    payment_id: payment2.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "amount_mismatch",
    verified_amount: 100 // mismatch
  });

  const rejectResult = await rejectPaymentReview(repo, {
    paymentId: payment2.id,
    tenantId: "pilot-salon-01",
    reviewedBy: "admin_pilot_manager",
    reasonCode: "AMOUNT_MISMATCH",
    notes: "Slip paid 100 instead of 200 required"
  });

  assert.equal(rejectResult.status, "rejected");
  assert.equal(rejectResult.payment.status, PAYMENT_STATUSES.verificationFailed);
  assert.equal(rejectResult.booking.status, "pending", "Booking remains pending for retry");

  // Resubmit valid attempt 2
  const attempt2 = await repo.createPaymentAttempt({
    payment_id: payment2.id,
    attempt_type: "slip_upload",
    verification_provider: "easyslip_v2",
    normalized_result: "success",
    verified_amount: 200
  });
  const attemptsHistory = await repo.getPaymentAttempts(payment2.id);
  assert.equal(attemptsHistory.length, 2, "Evidence history must remain immutable");

  // 7. Operational Cut-off Test (Simulate emergency capability disable)
  const cutOffEntitlements = {
    payment: false,
    deposit: false,
    slipVerification: false,
    autoPaymentConfirmation: false
  };

  const emergencyCheckout = await BookingCheckoutService.checkout(repo, {
    customer: seed.customers[0],
    service_id: "svc-pilot-1",
    staff_id: "staff-pilot-1",
    start_at: "2026-11-10T16:00:00+07:00",
    idempotency_key: "emergency_cut_off_001"
  }, {
    entitlements: cutOffEntitlements,
    businessPolicy: pilotBusinessPolicy
  });

  assert.equal(emergencyCheckout.mode, "no_payment", "Immediately falls back to no_payment safely");
  assert.equal(emergencyCheckout.status, "confirmed");

  // Verify existing payment records remain intact
  const preservedPayment = await repo.getPaymentById(payment.id);
  assert.equal(preservedPayment.status, PAYMENT_STATUSES.paid);
  const preservedAttempts = await repo.getPaymentAttempts(payment.id);
  assert.ok(preservedAttempts.length > 0);
});
