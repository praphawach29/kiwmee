// Salon Booking OS v1 - Payment Domain Unit & Foundation Test Suite
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  PAYMENT_TYPES,
  toSatang,
  fromSatang,
  calculatePricing,
  PAYMENT_STATUSES,
  canTransition,
  validateTransition,
  InvalidPaymentTransitionError,
  createPayment,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule,
  confirmVerifiedPayment,
  PaymentConfirmationError,
  calculateRefundBalances,
  decideRefund,
  requestRefund,
  completeRefundMock,
  MockSlipProvider,
  MOCK_SLIP_SCENARIOS,
  MockPaymentProvider
} = require("../src/payment");

const { FakeRepository, buildSeed } = require("./fake-repository");

// Helper to seed a confirmed booking in FakeRepository
async function makeTestBooking(repository, status = "pending") {
  const customerId = randomUUID();
  repository.customers.push({ id: customerId, name: "กมลพร", phone: "0891234567" });
  const booking = {
    id: randomUUID(),
    customer_id: customerId,
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00",
    end_at: "2026-09-10T14:00:00+07:00",
    status,
    source: "web"
  };
  repository.bookings.push(booking);
  return booking;
}

// =============================================================================
// 1. Pricing Calculator Tests
// =============================================================================

test("Pricing: no_payment policy sets amountDue to 0", () => {
  const result = calculatePricing({
    servicePrice: 1500,
    businessPolicy: { payment_type: PAYMENT_TYPES.noPayment }
  });
  assert.equal(result.servicePrice, 1500);
  assert.equal(result.amountDue, 0);
  assert.equal(result.remainingDue, 1500);
  assert.equal(result.paymentType, PAYMENT_TYPES.noPayment);
});

test("Pricing: fixed deposit sets exact amountDue capped at service price", () => {
  const result1 = calculatePricing({
    servicePrice: 1500,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 500 }
  });
  assert.equal(result1.amountDue, 500);
  assert.equal(result1.remainingDue, 1000);

  // Fixed deposit exceeding price is capped
  const result2 = calculatePricing({
    servicePrice: 300,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 500 }
  });
  assert.equal(result2.amountDue, 300);
  assert.equal(result2.remainingDue, 0);
});

test("Pricing: percentage deposit calculates deterministic amountDue", () => {
  // 2500 THB @ 30% = 750.00 THB
  const result = calculatePricing({
    servicePrice: 2500,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 30 }
  });
  assert.equal(result.amountDue, 750);
  assert.equal(result.remainingDue, 1750);
});

test("Pricing: full_payment sets amountDue equal to servicePrice", () => {
  const result = calculatePricing({
    servicePrice: 1200,
    businessPolicy: { payment_type: PAYMENT_TYPES.fullPayment }
  });
  assert.equal(result.amountDue, 1200);
  assert.equal(result.remainingDue, 0);
});

test("Pricing: service override takes precedence over business default and baseline", () => {
  const result = calculatePricing({
    servicePrice: 2000,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 300 },
    servicePolicy: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 50 }
  });
  // Service percentage (50% of 2000 = 1000) overrides business fixed (300)
  assert.equal(result.amountDue, 1000);
  assert.equal(result.policySource, "service");
});

test("Pricing: deterministic satang rounding prevents floating point error", () => {
  // 333.33 THB @ 33% -> 33333 satang * 0.33 = 10999.89 satang -> round to 11000 satang = 110.00 THB
  const result = calculatePricing({
    servicePrice: 333.33,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositPercentage, percentage: 33 }
  });
  assert.equal(result.amountDue, 110);
  assert.equal(typeof result.amountDue, "number");
  assert.equal(toSatang(0.1 + 0.2), 30); // 0.1 + 0.2 float issue handled cleanly
});

// =============================================================================
// 2. Payment State Machine Tests
// =============================================================================

test("State machine: allows valid sequential transitions", () => {
  assert.equal(canTransition(PAYMENT_STATUSES.pending, PAYMENT_STATUSES.slipReceived), true);
  assert.equal(canTransition(PAYMENT_STATUSES.slipReceived, PAYMENT_STATUSES.verifying), true);
  assert.equal(canTransition(PAYMENT_STATUSES.verifying, PAYMENT_STATUSES.paid), true);
  assert.equal(canTransition(PAYMENT_STATUSES.verifying, PAYMENT_STATUSES.manualReview), true);
  assert.equal(canTransition(PAYMENT_STATUSES.verifying, PAYMENT_STATUSES.verificationFailed), true);
  assert.equal(canTransition(PAYMENT_STATUSES.pending, PAYMENT_STATUSES.expired), true);
  assert.equal(canTransition(PAYMENT_STATUSES.manualReview, PAYMENT_STATUSES.paid), true);
  assert.equal(canTransition(PAYMENT_STATUSES.verificationFailed, PAYMENT_STATUSES.slipReceived), true);
});

test("State machine: rejects invalid transitions and throws InvalidPaymentTransitionError", () => {
  assert.equal(canTransition(PAYMENT_STATUSES.paid, PAYMENT_STATUSES.pending), false);
  assert.equal(canTransition(PAYMENT_STATUSES.expired, PAYMENT_STATUSES.paid), false);
  assert.equal(canTransition(PAYMENT_STATUSES.paid, PAYMENT_STATUSES.verifying), false);

  assert.throws(() => {
    validateTransition(PAYMENT_STATUSES.paid, PAYMENT_STATUSES.pending);
  }, InvalidPaymentTransitionError);

  assert.throws(() => {
    validateTransition("UNKNOWN_STATUS", PAYMENT_STATUSES.paid);
  }, /is not a recognized payment status/);
});

// =============================================================================
// 3. Slip Verification & Amount Verification Policy Tests
// =============================================================================

test("Verification: exact payment is eligible for automatic confirmation", async () => {
  const provider = new MockSlipProvider({ scenario: MOCK_SLIP_SCENARIOS.VALID });
  const payment = { amount_due: 500, business_id: "default" };

  const verificationResult = await provider.verifySlip({
    expectedAmount: 500,
    expectedReceiver: "0812345678"
  });

  const evaluation = evaluateSlipVerification({
    payment,
    verificationResult,
    expectedReceiver: "0812345678"
  });

  assert.equal(evaluation.eligibleForAutoConfirmation, true);
  assert.equal(evaluation.recommendedStatus, PAYMENT_STATUSES.paid);
  assert.equal(evaluation.reasonCode, "EXACT_AMOUNT_MATCH");
});

test("Verification: underpayment results in AMOUNT_MISMATCH and verification failure", async () => {
  const provider = new MockSlipProvider({ scenario: MOCK_SLIP_SCENARIOS.AMOUNT_MISMATCH });
  const payment = { amount_due: 500, business_id: "default" };

  const verificationResult = await provider.verifySlip({
    expectedAmount: 500,
    expectedReceiver: "0812345678"
  });

  const evaluation = evaluateSlipVerification({
    payment,
    verificationResult,
    expectedReceiver: "0812345678"
  });

  assert.equal(evaluation.eligibleForAutoConfirmation, false);
  assert.equal(evaluation.recommendedStatus, PAYMENT_STATUSES.verificationFailed);
  assert.equal(evaluation.reasonCode, "AMOUNT_MISMATCH_UNDERPAID");
});

test("Verification: overpayment escalates to manual review, never auto-paid", async () => {
  const provider = new MockSlipProvider({ scenario: MOCK_SLIP_SCENARIOS.OVERPAYMENT });
  const payment = { amount_due: 500, business_id: "default" };

  const verificationResult = await provider.verifySlip({
    expectedAmount: 500,
    expectedReceiver: "0812345678"
  });

  const evaluation = evaluateSlipVerification({
    payment,
    verificationResult,
    expectedReceiver: "0812345678"
  });

  assert.equal(evaluation.eligibleForAutoConfirmation, false);
  assert.equal(evaluation.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evaluation.reasonCode, "OVERPAYMENT_MANUAL_REVIEW");
});

test("Verification: receiver mismatch escalates to manual review, never auto-paid", async () => {
  const provider = new MockSlipProvider({ scenario: MOCK_SLIP_SCENARIOS.RECEIVER_MISMATCH });
  const payment = { amount_due: 500, business_id: "default" };

  const verificationResult = await provider.verifySlip({
    expectedAmount: 500,
    expectedReceiver: "0812345678"
  });

  const evaluation = evaluateSlipVerification({
    payment,
    verificationResult,
    expectedReceiver: "0812345678"
  });

  assert.equal(evaluation.eligibleForAutoConfirmation, false);
  assert.equal(evaluation.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evaluation.reasonCode, "RECEIVER_MISMATCH");
});

test("Verification: timeout throws provider error to allow manual review fallback", async () => {
  const provider = new MockSlipProvider({ scenario: MOCK_SLIP_SCENARIOS.TIMEOUT });

  await assert.rejects(async () => {
    await provider.verifySlip({ expectedAmount: 500 });
  }, /timed out/);
});

// =============================================================================
// 4. Atomic Payment Confirmation Service Tests
// =============================================================================

test("Atomic confirmation: success atomically updates payment + booking + audit + allocation + outbox", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeTestBooking(repository, "pending");

  const payment = await createPayment(repository, {
    bookingId: booking.id,
    servicePrice: 1000,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 400 }
  });

  assert.equal(payment.status, PAYMENT_STATUSES.pending);
  assert.equal(payment.amount_due, 400);

  const result = await confirmVerifiedPayment(repository, {
    paymentId: payment.id,
    verifiedAmount: 400,
    transactionNamespace: "promptpay",
    transactionReference: "TXN_OK_12345",
    actor: "slip_verifier"
  });

  assert.equal(result.status, "success");
  assert.equal(result.payment.status, PAYMENT_STATUSES.paid);
  assert.equal(result.payment.amount_paid, 400);
  assert.equal(result.booking.status, "confirmed");

  // Verify DB state
  const updatedBooking = repository.bookings.find((b) => b.id === booking.id);
  assert.equal(updatedBooking.status, "confirmed");

  const events = repository.paymentEvents.filter((e) => e.payment_id === payment.id);
  assert.ok(events.some((e) => e.event_type === "payment_confirmed" && e.to_status === "paid"));

  const history = repository.bookingStatusHistory.filter((h) => h.booking_id === booking.id);
  assert.ok(history.some((h) => h.to_status === "confirmed" && h.reason === "payment_confirmed"));

  const allocs = repository.paymentAllocations.filter((a) => a.payment_id === payment.id);
  assert.ok(allocs.some((a) => a.status === "active" && a.amount === 400));

  const outbox = repository.automationJobs.filter((j) => j.booking_id === booking.id);
  assert.ok(outbox.some((j) => j.automation_type === "booking_confirmation"));
});

test("Atomic confirmation: duplicate confirmation returns idempotent result without re-executing", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeTestBooking(repository, "pending");

  const payment = await createPayment(repository, {
    bookingId: booking.id,
    servicePrice: 500,
    businessPolicy: { payment_type: PAYMENT_TYPES.fullPayment }
  });

  const first = await confirmVerifiedPayment(repository, {
    paymentId: payment.id,
    verifiedAmount: 500,
    transactionNamespace: "promptpay",
    transactionReference: "TXN_DUPLICATE_TEST"
  });
  assert.equal(first.idempotent, false);

  const second = await confirmVerifiedPayment(repository, {
    paymentId: payment.id,
    verifiedAmount: 500,
    transactionNamespace: "promptpay",
    transactionReference: "TXN_DUPLICATE_TEST"
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.status, "idempotent_success");
});

test("Atomic confirmation: failure mid-transaction rolls back all changes cleanly", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeTestBooking(repository, "pending");

  const payment = await createPayment(repository, {
    bookingId: booking.id,
    servicePrice: 1000,
    businessPolicy: { payment_type: PAYMENT_TYPES.fullPayment }
  });

  // Force an error inside updateBookingStatus
  const originalUpdate = repository.updateBookingStatus.bind(repository);
  repository.updateBookingStatus = async () => {
    throw new Error("Simulated database failure during booking confirmation");
  };

  await assert.rejects(async () => {
    await confirmVerifiedPayment(repository, {
      paymentId: payment.id,
      verifiedAmount: 1000,
      transactionNamespace: "promptpay",
      transactionReference: "TXN_ROLLBACK_TEST"
    });
  }, /Simulated database failure/);

  // Restore method
  repository.updateBookingStatus = originalUpdate;

  // Confirm that payment was NOT updated to 'paid' and booking remained 'pending'
  const currentPayment = await repository.getPaymentForUpdate(payment.id);
  assert.equal(currentPayment.status, PAYMENT_STATUSES.pending);
  assert.equal(currentPayment.amount_paid, 0);

  const currentBooking = repository.bookings.find((b) => b.id === booking.id);
  assert.equal(currentBooking.status, "pending");
});

// =============================================================================
// 5. Payment Allocation & Reschedule Semantics Tests
// =============================================================================

test("Allocation: initial allocation is created and linked to original booking", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeTestBooking(repository, "pending");

  const payment = await createPayment(repository, {
    bookingId: booking.id,
    servicePrice: 1000,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 300 }
  });

  const allocs = await repository.getPaymentAllocations(payment.id);
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].booking_id, booking.id);
  assert.equal(allocs[0].amount, 300);
  assert.equal(allocs[0].status, "active");
  assert.equal(allocs[0].allocation_type, "initial");
  assert.equal(payment.original_booking_id, booking.id);
});

test("Allocation: reschedule transfers allocation from Booking A to Booking B while original_booking_id remains immutable", async () => {
  const repository = new FakeRepository(buildSeed());
  const bookingA = await makeTestBooking(repository, "confirmed");
  const bookingB = await makeTestBooking(repository, "pending");

  const payment = await createPayment(repository, {
    bookingId: bookingA.id,
    servicePrice: 1000,
    businessPolicy: { payment_type: PAYMENT_TYPES.depositFixed, fixed_amount: 400 }
  });

  // Reschedule transfer
  const newAlloc = await transferAllocationForReschedule(repository, {
    paymentId: payment.id,
    fromBookingId: bookingA.id,
    toBookingId: bookingB.id,
    amount: 400
  });

  assert.equal(newAlloc.booking_id, bookingB.id);
  assert.equal(newAlloc.status, "active");
  assert.equal(newAlloc.allocation_type, "reschedule_transfer");

  const allocs = await repository.getPaymentAllocations(payment.id);
  const oldAlloc = allocs.find((a) => a.booking_id === bookingA.id);
  assert.equal(oldAlloc.status, "transferred");
  assert.ok(oldAlloc.released_at);

  // IMMUTABLE CHECK: original_booking_id MUST NOT change
  const currentPayment = await repository.getPaymentForUpdate(payment.id);
  assert.equal(currentPayment.original_booking_id, bookingA.id);
});

// =============================================================================
// 6. Verification Grace Logic Tests
// =============================================================================

test("Grace: pending payment is eligible for expiry once expires_at is passed", () => {
  const past = new Date(Date.now() - 5000).toISOString();
  const payment = { status: PAYMENT_STATUSES.pending, expires_at: past, verification_deadline: null };

  const evaluation = evaluateVerificationGrace(payment, new Date());
  assert.equal(evaluation.action, "EXPIRE");
  assert.equal(evaluation.eligibleForRelease, true);
});

test("Grace: verifying payment within verification_deadline does NOT release even if expires_at passed", () => {
  const pastExpires = new Date(Date.now() - 5000).toISOString();
  const futureDeadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const payment = {
    status: PAYMENT_STATUSES.verifying,
    expires_at: pastExpires,
    verification_deadline: futureDeadline
  };

  const evaluation = evaluateVerificationGrace(payment, new Date());
  assert.equal(evaluation.action, "WAIT_GRACE");
  assert.equal(evaluation.eligibleForRelease, false);
});

test("Grace: verifying payment that exceeds verification_deadline escalates to manual review", () => {
  const pastExpires = new Date(Date.now() - 20000).toISOString();
  const pastDeadline = new Date(Date.now() - 5000).toISOString();

  const payment = {
    status: PAYMENT_STATUSES.verifying,
    expires_at: pastExpires,
    verification_deadline: pastDeadline
  };

  const evaluation = evaluateVerificationGrace(payment, new Date());
  assert.equal(evaluation.action, "ESCALATE_MANUAL_REVIEW");
  assert.equal(evaluation.eligibleForRelease, false);
});

// =============================================================================
// 7. Refund Decision & Calculation Tests
// =============================================================================

test("Refund: balance calculation correctly tracks completed and in-flight refunds", () => {
  const payment = { amount_paid: 1000 };
  const existingRefunds = [
    { amount: 200, status: "completed" },
    { amount: 300, status: "pending" }
  ];

  const balances = calculateRefundBalances(payment, existingRefunds);
  assert.equal(balances.amountPaid, 1000);
  assert.equal(balances.completedRefundTotal, 200);
  assert.equal(balances.inFlightRefundTotal, 300);
  assert.equal(balances.refundableBalance, 500);
});

test("Refund: multiple partial refunds allowed until refundable balance is depleted", () => {
  const payment = { amount_paid: 1000 };
  const existingRefunds = [{ amount: 400, status: "completed" }];

  const decision1 = decideRefund({ payment, refunds: existingRefunds, requestedAmount: 300 });
  assert.equal(decision1.approved, true);
  assert.equal(decision1.remainingBalanceAfterRefund, 300);

  // Second partial refund for remaining 300
  const updatedRefunds = [...existingRefunds, { amount: 300, status: "completed" }];
  const decision2 = decideRefund({ payment, refunds: updatedRefunds, requestedAmount: 300 });
  assert.equal(decision2.approved, true);
  assert.equal(decision2.remainingBalanceAfterRefund, 0);

  // Further refund is rejected
  const finalRefunds = [...updatedRefunds, { amount: 300, status: "completed" }];
  const decision3 = decideRefund({ payment, refunds: finalRefunds, requestedAmount: 50 });
  assert.equal(decision3.approved, false);
  assert.equal(decision3.reason, "EXCEEDS_REFUNDABLE_BALANCE");
});

test("Refund: over-refund is strictly rejected", () => {
  const payment = { amount_paid: 500 };
  const decision = decideRefund({ payment, refunds: [], requestedAmount: 501 });
  assert.equal(decision.approved, false);
  assert.equal(decision.reason, "EXCEEDS_REFUNDABLE_BALANCE");
});

test("Refund: request and mock execution records audit and idempotent keys", async () => {
  const repository = new FakeRepository(buildSeed());
  const booking = await makeTestBooking(repository, "confirmed");

  const payment = await repository.insertPayment({
    id: randomUUID(),
    original_booking_id: booking.id,
    amount_due: 800,
    amount_paid: 800,
    status: PAYMENT_STATUSES.paid,
    idempotency_key: `pay_${Date.now()}`
  });

  const req1 = await requestRefund(repository, {
    paymentId: payment.id,
    bookingId: booking.id,
    amount: 400,
    reason: "Customer cancelled within policy",
    idempotencyKey: "ref_idem_1001",
    approvedBy: "manager_ann"
  });

  assert.equal(req1.idempotent, false);
  assert.equal(req1.refund.status, "pending");

  // Duplicate request returns idempotent response
  const req2 = await requestRefund(repository, {
    paymentId: payment.id,
    bookingId: booking.id,
    amount: 400,
    reason: "Customer cancelled within policy",
    idempotencyKey: "ref_idem_1001",
    approvedBy: "manager_ann"
  });
  assert.equal(req2.idempotent, true);

  // Complete mock execution
  const completed = await completeRefundMock(repository, {
    refundId: req1.refund.id,
    providerRefundId: "p_ref_mock_999"
  });

  assert.equal(completed.refund.status, "completed");

  const events = repository.paymentEvents.filter((e) => e.payment_id === payment.id);
  assert.ok(events.some((e) => e.event_type === "refund_requested"));
  assert.ok(events.some((e) => e.event_type === "refund_completed"));
});
