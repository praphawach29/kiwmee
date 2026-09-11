// Salon Booking OS v1 - Payment Phase D Test Suite
// Covers:
// 1. Payment Policy Resolution (Precedence, Capabilities, Deposit fallback)
// 2. Booking Orchestration Integration (no_payment vs payment_required)
// 3. Slot Hold & Atomic Creation
// 4. Idempotent Checkout (Duplicate confirm returns existing booking/payment)
// 5. Expiry & Verification Grace (HOLD, EXPIRE, WAIT_GRACE, MANUAL_REVIEW, slot release)
// 6. Data Safety & Result Contract (No leaked secrets, standard contract format)
// 7. No-Payment Regression (100% backward compatible existing behavior)

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  PAYMENT_TYPES,
  PAYMENT_STATUSES,
  toSatang,
  fromSatang,
  resolvePaymentPolicy,
  resolveCapabilities,
  BookingCheckoutService,
  checkoutBooking,
  formatPaymentPendingResult,
  expirePendingPaymentHold,
  createPendingBookingWithPayment
} = require("../src/payment");

const { FEATURES } = require("../src/licensing/features");
const { FakeRepository, buildSeed } = require("./fake-repository");
const { createBooking } = require("../src/automation/booking-orchestration");

// =============================================================================
// 1. Payment Policy Resolution Tests
// =============================================================================

test("Policy Resolution: service override > business default > system baseline", async () => {
  // 1. Baseline default when nothing is configured
  const baseline = await resolvePaymentPolicy({
    entitlements: { payment: true, deposit: true }
  });
  assert.equal(baseline.payment_type, PAYMENT_TYPES.noPayment);
  assert.equal(baseline.source, "system_baseline");

  // 2. Business default when service has no override
  const businessPolicy = { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 150 };
  const fromBusiness = await resolvePaymentPolicy({
    businessSettings: businessPolicy,
    entitlements: { payment: true, deposit: true }
  });
  assert.equal(fromBusiness.payment_type, PAYMENT_TYPES.depositFixed);
  assert.equal(fromBusiness.fixed_amount, 150);
  assert.equal(fromBusiness.source, "business_default");

  // 3. Service override takes precedence over business default
  const servicePolicy = { payment_type: PAYMENT_TYPES.fullPayment };
  const fromService = await resolvePaymentPolicy({
    businessSettings: businessPolicy,
    serviceSettings: servicePolicy,
    entitlements: { payment: true, deposit: true }
  });
  assert.equal(fromService.payment_type, PAYMENT_TYPES.fullPayment);
  assert.equal(fromService.source, "service_override");
});

test("Policy Resolution: payment=false forces no_payment baseline", async () => {
  const resolved = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
    serviceSettings: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 50 },
    entitlements: { payment: false, deposit: true }
  });

  assert.equal(resolved.payment_type, PAYMENT_TYPES.noPayment);
  assert.equal(resolved.reason, "payment_disabled");
  assert.equal(resolved.paymentAllowed, false);
});

test("Policy Resolution: payment=true and deposit=false permits full_payment or no_payment, forbids deposit", async () => {
  // full_payment is allowed when payment=true even if deposit=false
  const full = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
    entitlements: { payment: true, deposit: false }
  });
  assert.equal(full.payment_type, PAYMENT_TYPES.fullPayment);

  // no_payment is allowed
  const noPay = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.noPayment },
    entitlements: { payment: true, deposit: false }
  });
  assert.equal(noPay.payment_type, PAYMENT_TYPES.noPayment);

  // deposit_fixed falls back when deposit feature is disabled
  const depositFixed = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: false }
  });
  assert.equal(depositFixed.payment_type, PAYMENT_TYPES.noPayment);
  assert.equal(depositFixed.reason, "deposit_feature_disabled");

  // deposit_percentage falls back when deposit feature is disabled
  const depositPct = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 30 },
    entitlements: { payment: true, deposit: false }
  });
  assert.equal(depositPct.payment_type, PAYMENT_TYPES.noPayment);
  assert.equal(depositPct.reason, "deposit_feature_disabled");
});

test("Policy Resolution: deposit=true allows deposit_fixed and deposit_percentage", async () => {
  const fixed = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 250 },
    entitlements: { payment: true, deposit: true }
  });
  assert.equal(fixed.payment_type, PAYMENT_TYPES.depositFixed);
  assert.equal(fixed.fixed_amount, 250);

  const pct = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 40 },
    entitlements: { payment: true, deposit: true }
  });
  assert.equal(pct.payment_type, PAYMENT_TYPES.depositPercentage);
  assert.equal(pct.percentage, 40);
});

test("Policy Resolution: never checks plan names", async () => {
  // Using capability function directly without any plan name concept
  const mockHasFeature = async (bId, feature) => {
    return feature === FEATURES.payment; // deposit is false
  };

  const resolved = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
    hasFeatureFn: mockHasFeature
  });

  assert.equal(resolved.payment_type, PAYMENT_TYPES.fullPayment);
  assert.equal(resolved.paymentAllowed, true);
  assert.equal(resolved.depositAllowed, false);
});

// =============================================================================
// 2. Booking Orchestration & Checkout Service Tests
// =============================================================================

test("Checkout: no_payment produces confirmed booking and zero payment rows (Regression)", async () => {
  const repo = new FakeRepository(buildSeed());
  const input = {
    customer: { name: "Regular Customer", phone: "0811111111" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T10:00:00+07:00",
    source: "web"
  };

  // Checkout with no_payment policy
  const result = await BookingCheckoutService.checkout(repo, input, {
    entitlements: { payment: false }
  });

  assert.equal(result.mode, "no_payment");
  assert.equal(result.status, "confirmed");
  assert.ok(result.booking.id);
  assert.equal(result.booking.status, "confirmed");
  assert.equal(result.payment, null);

  // Zero payments created in repository
  assert.equal(repo.payments.length, 0);

  // Existing automation outbox job is enqueued unchanged
  const outbox = repo.automationJobs.filter((j) => j.booking_id === result.booking.id);
  assert.ok(outbox.length > 0, "Booking confirmation automation job was scheduled");
});

test("Checkout: fixed deposit creates pending booking and active payment hold", async () => {
  const repo = new FakeRepository(buildSeed());
  const input = {
    customer: { name: "Deposit Customer", phone: "0822222222" },
    service_id: "svc-cut", // price: 500
    staff_id: "staff-ann",
    start_at: "2026-09-10T11:00:00+07:00",
    source: "web"
  };

  const result = await BookingCheckoutService.checkout(repo, input, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true }
  });

  assert.equal(result.mode, "payment_required");
  assert.equal(result.status, "payment_pending");
  assert.ok(result.bookingId);
  assert.ok(result.paymentId);
  assert.equal(result.amountDue, 200);
  assert.equal(result.currency, "THB");
  assert.equal(result.booking.status, "pending");
  assert.equal(result.payment.type, "deposit_fixed");
  assert.equal(result.payment.amountDueSatang, 20000);
  assert.ok(result.expiresAt);

  // Check repository state
  assert.equal(repo.payments.length, 1);
  const payment = repo.payments[0];
  assert.equal(payment.id, result.paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.pending);
  assert.equal(payment.original_booking_id, result.bookingId);

  // Active payment allocation exists
  const alloc = await repo.getActivePaymentAllocation(result.bookingId);
  assert.ok(alloc);
  assert.equal(alloc.payment_id, payment.id);
  assert.equal(alloc.amount, 200);
  assert.equal(alloc.status, "active");
});

test("Checkout: percentage deposit calculates deterministic amount in satang", async () => {
  const repo = new FakeRepository(buildSeed());
  const input = {
    customer: { name: "Pct Customer", phone: "0833333333" },
    service_id: "svc-color", // price: 2500
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00"
  };

  const result = await BookingCheckoutService.checkout(repo, input, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 30 },
    entitlements: { payment: true, deposit: true }
  });

  // 30% of 1500 = 450 THB (45000 satang)
  assert.equal(result.amountDue, 450);
  assert.equal(result.payment.amountDueSatang, 45000);
  assert.equal(result.booking.status, "pending");
});

test("Checkout: full payment requires 100% of service price", async () => {
  const repo = new FakeRepository(buildSeed());
  const input = {
    customer: { name: "Full Pay Customer", phone: "0844444444" },
    service_id: "svc-cut", // price: 500
    staff_id: "staff-ann",
    start_at: "2026-09-10T15:00:00+07:00"
  };

  const result = await BookingCheckoutService.checkout(repo, input, {
    businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
    entitlements: { payment: true, deposit: false } // even with deposit=false, full payment is allowed
  });

  assert.equal(result.amountDue, 500);
  assert.equal(result.payment.amountDueSatang, 50000);
  assert.equal(result.payment.type, "full_payment");
});

test("Checkout: service override takes precedence over business default", async () => {
  const repo = new FakeRepository(buildSeed());
  const input = {
    customer: { name: "Override Customer", phone: "0855555555" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T16:00:00+07:00"
  };

  const result = await BookingCheckoutService.checkout(repo, input, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 100 },
    serviceSettings: { payment_type: PAYMENT_TYPES.fullPayment },
    entitlements: { payment: true, deposit: true }
  });

  // Service override (full_payment = 500) overrides business default (fixed = 100)
  assert.equal(result.amountDue, 500);
  assert.equal(result.payment.type, "full_payment");
});

// =============================================================================
// 3. Idempotent Checkout Tests
// =============================================================================

test("Checkout: duplicate confirm with same idempotency key returns existing booking and payment", async () => {
  const repo = new FakeRepository(buildSeed());
  const idempotencyKey = `idemp_test_${Date.now()}`;
  const input = {
    customer: { name: "Repeat Clicker", phone: "0866666666" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T17:00:00+07:00",
    idempotency_key: idempotencyKey
  };

  const options = {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    idempotencyKey
  };

  // First checkout
  const first = await BookingCheckoutService.checkout(repo, input, options);
  assert.equal(first.isExisting, false);
  assert.equal(repo.payments.length, 1);
  assert.equal(repo.bookings.length, 1);

  // Second duplicate checkout with identical key
  const second = await BookingCheckoutService.checkout(repo, input, options);
  assert.equal(second.isExisting, true);
  assert.equal(second.bookingId, first.bookingId);
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(second.amountDue, first.amountDue);

  // Invariant: No duplicate booking or payment created
  assert.equal(repo.payments.length, 1);
  assert.equal(repo.bookings.length, 1);
  assert.equal(repo.paymentAllocations.length, 1);
});

// =============================================================================
// 4. Slot Hold & Conflict Tests
// =============================================================================

test("Slot Hold: pending booking blocks slot; conflicting second customer creates no payment", async () => {
  const repo = new FakeRepository(buildSeed());

  // Customer A successfully creates pending booking on 14:00 - 14:45
  const first = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Customer A", phone: "0811111111" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true }
  });

  assert.equal(first.booking.status, "pending");
  assert.equal(repo.payments.length, 1);

  // Customer B attempts overlapping slot on same staff (14:30)
  const paymentsBeforeConflict = repo.payments.length;
  await assert.rejects(
    BookingCheckoutService.checkout(repo, {
      customer: { name: "Customer B", phone: "0822222222" },
      service_id: "svc-cut",
      staff_id: "staff-ann",
      start_at: "2026-09-10T14:30:00+07:00"
    }, {
      businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
      entitlements: { payment: true, deposit: true }
    }),
    /slot is not available|overlap constraint violation/i
  );

  // Invariant: Loser creates no payment, no booking
  assert.equal(repo.payments.length, paymentsBeforeConflict);
  assert.equal(repo.bookings.length, 1);
});

test("Mid-Transaction Failure: rollback leaves no orphan booking, payment, or allocation", async () => {
  class BrokenAllocationRepository extends FakeRepository {
    async insertPaymentAllocation() {
      throw new Error("simulated database disk failure on allocation write");
    }
  }

  const brokenRepo = new BrokenAllocationRepository(buildSeed());
  await assert.rejects(
    BookingCheckoutService.checkout(brokenRepo, {
      customer: { name: "Orphan Hunter", phone: "0899999999" },
      service_id: "svc-cut",
      staff_id: "staff-ann",
      start_at: "2026-09-10T11:00:00+07:00"
    }, {
      businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
      entitlements: { payment: true, deposit: true }
    }),
    /simulated database disk failure/
  );

  // Invariant: Atomic rollback ensures zero orphan rows
  assert.equal(brokenRepo.bookings.length, 0);
  assert.equal(brokenRepo.payments.length, 0);
  assert.equal(brokenRepo.paymentAllocations.length, 0);
});

// =============================================================================
// 5. Expiry & Verification Grace Tests
// =============================================================================

test("Expiry: pending payment before expires_at maintains HOLD", async () => {
  const repo = new FakeRepository(buildSeed());
  const now = new Date("2026-09-10T10:00:00Z");

  const checkout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Holder", phone: "0812345678" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    now,
    expiryMinutes: 15
  });

  // Evaluate at now + 5 minutes (still within 15 minute window)
  const evaluationTime = new Date("2026-09-10T10:05:00Z");
  const holdResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: evaluationTime
  });

  assert.equal(holdResult.action, "HOLD");
  assert.equal(holdResult.status, "HOLD");

  // Booking and payment remain pending
  const booking = await repo.getBooking(checkout.bookingId);
  const payment = await repo.getPaymentById(checkout.paymentId);
  assert.equal(booking.status, "pending");
  assert.equal(payment.status, "pending");
});

test("Expiry: pending payment after expires_at transitions to EXPIRE and frees slot", async () => {
  const repo = new FakeRepository(buildSeed());
  const checkoutTime = new Date("2026-09-10T10:00:00Z");

  const checkout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Late Customer", phone: "0812345678" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    now: checkoutTime,
    expiryMinutes: 15
  });

  // Evaluate after expires_at (at 10:16Z)
  const afterExpiryTime = new Date("2026-09-10T10:16:00Z");
  const expireResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: afterExpiryTime
  });

  assert.equal(expireResult.action, "EXPIRE");
  assert.equal(expireResult.status, "EXPIRE");

  // Verify payment is expired
  const payment = await repo.getPaymentById(checkout.paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.expired);

  // Verify booking is expired
  const booking = await repo.getBooking(checkout.bookingId);
  assert.equal(booking.status, "expired");

  // Verify payment allocation is released
  const alloc = (await repo.getPaymentAllocations(payment.id))[0];
  assert.equal(alloc.status, "released");

  // Verify audit event inserted
  const event = repo.paymentEvents.find((e) => e.payment_id === payment.id && e.event_type === "payment_expired");
  assert.ok(event);

  // Verify booking status history recorded
  const history = repo.bookingStatusHistory.find((h) => h.booking_id === booking.id && h.to_status === "expired");
  assert.ok(history);

  // Invariant: Expired booking releases slot, allowing another customer to book that exact slot!
  const newCheckout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Replacement Customer", phone: "0898887777" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true }
  });

  assert.ok(newCheckout.bookingId);
  assert.equal(newCheckout.booking.status, "pending");
});

test("Expiry Grace: slip_received during grace returns WAIT_GRACE and preserves slot", async () => {
  const repo = new FakeRepository(buildSeed());
  const checkoutTime = new Date("2026-09-10T10:00:00Z");

  const checkout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Slip Customer", phone: "0812345678" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    now: checkoutTime,
    expiryMinutes: 15
  });

  // Customer uploaded slip before expires_at -> status moves to slip_received with verification deadline
  const verificationDeadline = new Date("2026-09-10T10:25:00Z").toISOString();
  await repo.updatePayment(checkout.paymentId, {
    status: PAYMENT_STATUSES.slipReceived,
    verification_deadline: verificationDeadline
  });

  // Now time is 10:18Z (past expires_at 10:15Z, but BEFORE verification_deadline 10:25Z)
  const duringGraceTime = new Date("2026-09-10T10:18:00Z");
  const graceResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: duringGraceTime
  });

  assert.equal(graceResult.action, "WAIT_GRACE");
  assert.equal(graceResult.status, "WAIT_GRACE");

  // Booking and payment remain alive, slot is NOT released
  const booking = await repo.getBooking(checkout.bookingId);
  const payment = await repo.getPaymentById(checkout.paymentId);
  assert.equal(booking.status, "pending");
  assert.equal(payment.status, PAYMENT_STATUSES.slipReceived);
});

test("Expiry Grace: verifying during grace returns WAIT_GRACE and preserves slot", async () => {
  const repo = new FakeRepository(buildSeed());
  const checkoutTime = new Date("2026-09-10T10:00:00Z");

  const checkout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Verifying Customer", phone: "0812345678" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    now: checkoutTime,
    expiryMinutes: 15
  });

  // Provider is verifying slip
  const verificationDeadline = new Date("2026-09-10T10:25:00Z").toISOString();
  await repo.updatePayment(checkout.paymentId, {
    status: PAYMENT_STATUSES.verifying,
    verification_deadline: verificationDeadline
  });

  // 10:20Z is within grace period
  const graceResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: new Date("2026-09-10T10:20:00Z")
  });

  assert.equal(graceResult.action, "WAIT_GRACE");
  assert.equal(graceResult.status, "WAIT_GRACE");
  assert.equal(checkout.booking.status, "pending");
});

test("Expiry Grace: verifying after grace period escalates to MANUAL_REVIEW without auto-cancel", async () => {
  const repo = new FakeRepository(buildSeed());
  const checkoutTime = new Date("2026-09-10T10:00:00Z");

  const checkout = await BookingCheckoutService.checkout(repo, {
    customer: { name: "Stuck Verification Customer", phone: "0812345678" },
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T14:00:00+07:00"
  }, {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
    entitlements: { payment: true, deposit: true },
    now: checkoutTime,
    expiryMinutes: 15
  });

  // Verification deadline was 10:25Z
  const verificationDeadline = new Date("2026-09-10T10:25:00Z").toISOString();
  await repo.updatePayment(checkout.paymentId, {
    status: PAYMENT_STATUSES.verifying,
    verification_deadline: verificationDeadline
  });

  // Provider still hasn't answered by 10:30Z (past verification_deadline)
  const afterGraceTime = new Date("2026-09-10T10:30:00Z");
  const reviewResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: afterGraceTime
  });

  assert.equal(reviewResult.action, "MANUAL_REVIEW");
  assert.equal(reviewResult.status, "MANUAL_REVIEW");

  // Payment is escalated to manual_review, NOT cancelled/expired
  const payment = await repo.getPaymentById(checkout.paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview);

  // Booking remains pending so staff schedule is preserved while human investigates
  const booking = await repo.getBooking(checkout.bookingId);
  assert.equal(booking.status, "pending");

  // Payment event recorded
  const event = repo.paymentEvents.find((e) => e.payment_id === payment.id && e.event_type === "manual_review_requested");
  assert.ok(event);
});

// =============================================================================
// 6. Contract Formatting & Information Safety Tests
// =============================================================================

test("Result Contract: contains required fields and excludes internal secrets or errors", () => {
  const contract = formatPaymentPendingResult({
    booking: { id: "book-123", status: "pending" },
    payment: {
      id: "pay-456",
      payment_type: "deposit_fixed",
      amount_due: "200.00",
      currency: "THB",
      expires_at: "2026-09-10T10:15:00Z",
      verification_deadline: "2026-09-10T10:25:00Z",
      // Dangerous internal fields that must not be in contract
      secret_api_key: "sk_live_secret123",
      db_connection_error: "FATAL: password authentication failed"
    }
  });

  // Expected top-level fields
  assert.equal(contract.mode, "payment_required");
  assert.equal(contract.status, "payment_pending");
  assert.equal(contract.bookingId, "book-123");
  assert.equal(contract.paymentId, "pay-456");
  assert.equal(contract.amountDue, 200);
  assert.equal(contract.currency, "THB");
  assert.equal(contract.expiresAt, "2026-09-10T10:15:00Z");
  assert.equal(contract.verificationDeadline, "2026-09-10T10:25:00Z");

  // Expected nested contract objects
  assert.deepEqual(contract.booking, {
    id: "book-123",
    status: "pending"
  });

  assert.deepEqual(contract.payment, {
    id: "pay-456",
    type: "deposit_fixed",
    amountDueSatang: 20000,
    currency: "THB",
    expiresAt: "2026-09-10T10:15:00Z",
    verificationDeadline: "2026-09-10T10:25:00Z"
  });

  // Verify dangerous fields are completely excluded
  assert.equal(contract.secret_api_key, undefined);
  assert.equal(contract.db_connection_error, undefined);
  assert.equal(contract.payment.secret_api_key, undefined);
});

// =============================================================================
// 7. Hardening 1: No-Payment Checkout Idempotency Tests
// =============================================================================

test("Hardening 1: no_payment duplicate checkout returns same booking and does not duplicate automation jobs", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const input = {
    customer: { name: "Idempotent Customer", phone: "0811112222" },
    service_id: seed.services[0].id,
    staff_id: seed.staff[0].id,
    start_at: "2026-09-10T14:00:00+07:00",
    idempotency_key: "idem_nopay_123"
  };

  // First checkout
  const firstResult = await BookingCheckoutService.checkout(repo, input, {
    entitlements: { payment: false, deposit: false }
  });

  assert.equal(firstResult.mode, "no_payment");
  assert.equal(firstResult.status, "confirmed");
  assert.equal(firstResult.isExisting, false);
  const initialBookingId = firstResult.booking.id;

  // Automation jobs created for initial checkout
  const initialJobs = await repo.listAutomationJobsForBooking(initialBookingId);
  assert.ok(initialJobs.length > 0, "Automation jobs should be created on first checkout");
  const jobCount = initialJobs.length;

  // Duplicate checkout with identical idempotency key
  const secondResult = await BookingCheckoutService.checkout(repo, input, {
    entitlements: { payment: false, deposit: false }
  });

  assert.equal(secondResult.mode, "no_payment");
  assert.equal(secondResult.status, "confirmed");
  assert.equal(secondResult.isExisting, true);
  assert.equal(secondResult.booking.id, initialBookingId, "Must return existing booking");

  // Verify no new bookings were created
  const allBookings = repo.bookings.filter((b) => b.customer_id === firstResult.booking.customer_id);
  assert.equal(allBookings.length, 1, "Must not create duplicate booking rows");

  // Verify automation jobs were NOT duplicated
  const afterJobs = await repo.listAutomationJobsForBooking(initialBookingId);
  assert.equal(afterJobs.length, jobCount, "Automation jobs must not be duplicated on repeated checkout");
});

test("Hardening 1: payment_required duplicate checkout returns same booking and payment", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const input = {
    customer: { name: "Deposit Customer", phone: "0822223333" },
    service_id: seed.services[0].id,
    staff_id: seed.staff[0].id,
    start_at: "2026-09-10T15:00:00+07:00",
    idempotency_key: "idem_pay_456"
  };

  const options = {
    businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 150 },
    entitlements: { payment: true, deposit: true }
  };

  const firstResult = await BookingCheckoutService.checkout(repo, input, options);
  assert.equal(firstResult.mode, "payment_required");
  assert.equal(firstResult.status, "payment_pending");
  assert.equal(firstResult.isExisting, false);

  const secondResult = await BookingCheckoutService.checkout(repo, input, options);
  assert.equal(secondResult.mode, "payment_required");
  assert.equal(secondResult.status, "payment_pending");
  assert.equal(secondResult.isExisting, true);
  assert.equal(secondResult.bookingId, firstResult.bookingId);
  assert.equal(secondResult.paymentId, firstResult.paymentId);
});

test("Hardening 1: concurrent duplicate no_payment checkouts resolve to single booking", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const input = {
    customer: { name: "Racy Customer", phone: "0833334444" },
    service_id: seed.services[0].id,
    staff_id: seed.staff[0].id,
    start_at: "2026-09-10T16:00:00+07:00",
    idempotency_key: "idem_race_789"
  };

  // Launch two checkout requests concurrently with identical idempotency key
  const [res1, res2] = await Promise.all([
    BookingCheckoutService.checkout(repo, input, { entitlements: { payment: false, deposit: false } }),
    BookingCheckoutService.checkout(repo, input, { entitlements: { payment: false, deposit: false } })
  ]);

  assert.equal(res1.booking.id, res2.booking.id, "Both concurrent requests must return the exact same booking ID");
  assert.ok([res1.isExisting, res2.isExisting].includes(false));
  assert.ok([res1.isExisting, res2.isExisting].includes(true));

  // Exactly one booking row in database
  const matching = repo.bookings.filter((b) => b.checkout_idempotency_key === "idem_race_789");
  assert.equal(matching.length, 1);
});

// =============================================================================
// 8. Hardening 2: Financial Fail-Closed Policy Tests
// =============================================================================

test("Hardening 2: known payment=false + baseline no_payment -> allowed", async () => {
  const resolved = await resolvePaymentPolicy({
    businessSettings: { payment_type: PAYMENT_TYPES.noPayment },
    entitlements: { payment: false, deposit: false }
  });

  assert.equal(resolved.payment_type, PAYMENT_TYPES.noPayment);
});

test("Hardening 2: provider error + baseline no_payment -> existing flow remains safe", async () => {
  const faultyFeatureFn = async () => {
    throw new Error("Entitlement service timeout / unreachable");
  };

  // When no payment policy is configured, baseline is free booking and safe from entitlement outages
  const resolved = await resolvePaymentPolicy({
    businessSettings: undefined,
    hasFeatureFn: faultyFeatureFn
  });

  assert.equal(resolved.payment_type, PAYMENT_TYPES.noPayment);
  assert.equal(resolved.source, "system_baseline");
});

test("Hardening 2: provider error + required deposit policy -> checkout blocked (fail-closed)", async () => {
  const faultyFeatureFn = async () => {
    throw new Error("Database network socket error during entitlement check");
  };

  await assert.rejects(
    async () => {
      await resolvePaymentPolicy({
        businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 200 },
        hasFeatureFn: faultyFeatureFn
      });
    },
    (err) => {
      assert.equal(err.code, "PAYMENT_CAPABILITY_UNAVAILABLE");
      // Must not leak internal provider error message
      assert.ok(!err.message.includes("Database network socket error"));
      return true;
    }
  );
});

test("Hardening 2: provider error + full_payment policy -> checkout blocked (fail-closed)", async () => {
  const faultyFeatureFn = async () => {
    throw new Error("KMS authorization failure");
  };

  await assert.rejects(
    async () => {
      await resolvePaymentPolicy({
        businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
        hasFeatureFn: faultyFeatureFn
      });
    },
    (err) => {
      assert.equal(err.code, "PAYMENT_CAPABILITY_UNAVAILABLE");
      assert.ok(!err.message.includes("KMS authorization failure"));
      return true;
    }
  );
});

test("Hardening 2: blocked checkout leaves zero orphan rows in booking or payment tables", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);
  const initialBookingCount = repo.bookings.length;
  const initialPaymentCount = repo.payments.length;

  const faultyFeatureFn = async () => {
    throw new Error("Temporary network timeout");
  };

  await assert.rejects(async () => {
    await BookingCheckoutService.checkout(
      repo,
      {
        customer: { name: "Blocked Customer", phone: "0899990000" },
        service_id: seed.services[0].id,
        staff_id: seed.staff[0].id,
        start_at: "2026-09-10T17:00:00+07:00"
      },
      {
        businessSettings: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 100 },
        hasFeatureFn: faultyFeatureFn
      }
    );
  }, { code: "PAYMENT_CAPABILITY_UNAVAILABLE" });

  assert.equal(repo.bookings.length, initialBookingCount, "Must not create any orphan booking row");
  assert.equal(repo.payments.length, initialPaymentCount, "Must not create any orphan payment row");
});

// =============================================================================
// 9. Hardening 3: Manual Review Deadline Tests
// =============================================================================

test("Hardening 3: manual review before deadline keeps slot with HOLD_FOR_REVIEW", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const baseTime = new Date("2026-09-10T10:00:00Z");
  const checkout = await BookingCheckoutService.checkout(
    repo,
    {
      customer: { name: "Review Customer", phone: "0844445555" },
      service_id: seed.services[0].id,
      staff_id: seed.staff[0].id,
      start_at: "2026-09-10T11:00:00Z"
    },
    {
      businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
      entitlements: { payment: true, deposit: false },
      now: baseTime,
      expiryMinutes: 15
    }
  );

  // Escalate to manual review at T+26m (expires_at + verification_deadline passed)
  const escalateTime = new Date(baseTime.getTime() + 26 * 60 * 1000);
  // Simulate slip upload
  await repo.updatePayment(checkout.paymentId, {
    status: PAYMENT_STATUSES.verifying,
    verification_deadline: new Date(baseTime.getTime() + 25 * 60 * 1000).toISOString()
  });

  const escalateResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: escalateTime
  });

  assert.equal(escalateResult.action, "MANUAL_REVIEW");
  assert.ok(escalateResult.manualReviewDeadline, "manual_review_deadline must be set upon escalation");

  // Check state at T+30m (4 minutes into 15-minute manual review window)
  const reviewCheckTime = new Date(baseTime.getTime() + 30 * 60 * 1000);
  const holdResult = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: reviewCheckTime
  });

  assert.equal(holdResult.action, "HOLD_FOR_REVIEW");
  assert.equal(holdResult.status, "HOLD_FOR_REVIEW");

  // Slot is NOT released, booking remains pending
  const booking = await repo.getBooking(checkout.bookingId);
  assert.equal(booking.status, "pending", "Booking must remain pending during active review hold");
});

test("Hardening 3: manual review after deadline returns MANUAL_REVIEW_EXPIRED", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const baseTime = new Date("2026-09-10T10:00:00Z");
  const checkout = await BookingCheckoutService.checkout(
    repo,
    {
      customer: { name: "Review Customer 2", phone: "0855556666" },
      service_id: seed.services[0].id,
      staff_id: seed.staff[0].id,
      start_at: "2026-09-10T11:00:00Z"
    },
    {
      businessSettings: { payment_type: PAYMENT_TYPES.fullPayment },
      entitlements: { payment: true, deposit: false },
      now: baseTime,
      expiryMinutes: 15
    }
  );

  // Set to manual_review with deadline at T+25m
  const manualDeadline = new Date(baseTime.getTime() + 25 * 60 * 1000).toISOString();
  await repo.updatePayment(checkout.paymentId, {
    status: PAYMENT_STATUSES.manualReview,
    manual_review_deadline: manualDeadline
  });

  // Evaluate after deadline (T+26m)
  const afterDeadline = new Date(baseTime.getTime() + 26 * 60 * 1000);
  const result = await expirePendingPaymentHold(repo, {
    paymentId: checkout.paymentId,
    now: afterDeadline
  });

  assert.equal(result.action, "MANUAL_REVIEW_EXPIRED");
  assert.equal(result.status, "MANUAL_REVIEW_EXPIRED");

  // Invariant: does not automatically alter financial state without worker/admin intervention
  const payment = await repo.getPaymentById(checkout.paymentId);
  assert.equal(payment.status, PAYMENT_STATUSES.manualReview);
});

