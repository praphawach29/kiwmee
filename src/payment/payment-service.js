// Salon Booking OS v1 - Payment Service
// Domain operations for payment creation, slip evaluation, allocation, and verification grace

const { randomUUID } = require("node:crypto");
const { PAYMENT_STATUSES, validateTransition } = require("./payment-state-machine");
const { calculatePricing } = require("./pricing-calculator");

const DEFAULT_PAYMENT_EXPIRY_MINUTES = 15;
const DEFAULT_VERIFICATION_GRACE_MINUTES = 10;

/**
 * Creates a payment for a booking based on pricing policy.
 */
async function createPayment(repository, {
  businessId = "default",
  bookingId,
  servicePrice,
  servicePolicy,
  businessPolicy,
  provider = "promptpay_qr",
  idempotencyKey,
  now = new Date(),
  expiryMinutes = DEFAULT_PAYMENT_EXPIRY_MINUTES
}) {
  const pricing = calculatePricing({ servicePrice, servicePolicy, businessPolicy });

  const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString();
  const paymentId = randomUUID();

  const paymentRecord = {
    id: paymentId,
    business_id: businessId,
    original_booking_id: bookingId,
    payment_type: pricing.paymentType,
    provider,
    amount_due: pricing.amountDue,
    amount_paid: 0,
    currency: pricing.currency,
    status: PAYMENT_STATUSES.pending,
    provider_reference: null,
    transaction_namespace: provider,
    transaction_reference: null,
    idempotency_key: idempotencyKey || `pay_${bookingId}_${Date.now()}`,
    expires_at: expiresAt,
    verification_deadline: null,
    paid_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };

  return repository.transaction(async (tx) => {
    // Check idempotency
    const existing = await tx.findPaymentByIdempotencyKey?.(paymentRecord.idempotency_key);
    if (existing) {
      return existing;
    }

    const insertedPayment = await tx.insertPayment(paymentRecord);

    // Create initial payment allocation linking to original booking
    if (pricing.amountDue > 0) {
      await tx.insertPaymentAllocation({
        id: randomUUID(),
        payment_id: insertedPayment.id,
        booking_id: bookingId,
        amount: pricing.amountDue,
        allocation_type: "initial",
        status: "active",
        created_at: now.toISOString(),
        released_at: null,
        metadata: { payment_type: pricing.paymentType }
      });
    }

    // Insert append-only audit event
    await tx.insertPaymentEvent({
      id: randomUUID(),
      payment_id: insertedPayment.id,
      event_type: "payment_created",
      from_status: null,
      to_status: PAYMENT_STATUSES.pending,
      actor: "system",
      reason_code: "INITIAL_CREATION",
      metadata: { amount_due: pricing.amountDue, pricing },
      created_at: now.toISOString()
    });

    return insertedPayment;
  });
}

/**
 * Evaluates amount verification and receiver matching according to domain policy.
 * AI/OCR is never authoritative; strict normalized comparison against expected payment parameters.
 */
function evaluateSlipVerification({ payment, verificationResult, expectedReceiver }) {
  if (!verificationResult || verificationResult.normalized_result === "invalid_slip") {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: "INVALID_SLIP",
      description: "Slip could not be read or decoded"
    };
  }

  if (verificationResult.normalized_result === "duplicate") {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: "DUPLICATE_TRANSACTION",
      description: "Slip has already been used for another payment"
    };
  }

  // 1. Check receiver identity
  const expectedRec = expectedReceiver || payment.business_id;
  if (verificationResult.verified_receiver && expectedRec && verificationResult.verified_receiver !== expectedRec) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: "RECEIVER_MISMATCH",
      description: `Receiver ${verificationResult.verified_receiver} does not match expected ${expectedRec}`
    };
  }

  // 2. Strict amount verification
  const verifiedSatang = Math.round(Number(verificationResult.verified_amount || 0) * 100);
  const dueSatang = Math.round(Number(payment.amount_due) * 100);

  if (verifiedSatang === dueSatang) {
    return {
      eligibleForAutoConfirmation: true,
      recommendedStatus: PAYMENT_STATUSES.paid,
      reasonCode: "EXACT_AMOUNT_MATCH",
      description: "Verified amount matches amount due exactly"
    };
  }

  if (verifiedSatang < dueSatang) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: "AMOUNT_MISMATCH_UNDERPAID",
      description: `Verified amount (${verificationResult.verified_amount}) is less than amount due (${payment.amount_due})`
    };
  }

  // Overpayment (verifiedSatang > dueSatang) -> manual review, never auto-paid
  return {
    eligibleForAutoConfirmation: false,
    recommendedStatus: PAYMENT_STATUSES.manualReview,
    reasonCode: "OVERPAYMENT_MANUAL_REVIEW",
    description: `Verified amount (${verificationResult.verified_amount}) exceeds amount due (${payment.amount_due})`
  };
}

/**
 * Pure domain logic for checking verification grace periods.
 * Rules:
 * - pending + expires_at passed => ELIGIBLE_FOR_EXPIRY
 * - slip_received/verifying + expires_at passed, but verification_deadline NOT passed => WAIT_GRACE (not expired!)
 * - verifying + verification_deadline passed => ESCALATE_MANUAL_REVIEW
 */
function evaluateVerificationGrace(payment, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const expiresAt = new Date(payment.expires_at);
  const verificationDeadline = payment.verification_deadline ? new Date(payment.verification_deadline) : null;

  if (payment.status === PAYMENT_STATUSES.pending) {
    if (nowDate > expiresAt) {
      return { action: "EXPIRE", eligibleForRelease: true, reason: "Payment window expired without slip" };
    }
    return { action: "ACTIVE", eligibleForRelease: false, reason: "Payment window is active" };
  }

  if ([PAYMENT_STATUSES.slipReceived, PAYMENT_STATUSES.verifying].includes(payment.status)) {
    // Under verification grace
    if (verificationDeadline && nowDate <= verificationDeadline) {
      return {
        action: "WAIT_GRACE",
        eligibleForRelease: false,
        reason: "Customer uploaded slip before expires_at; verification deadline grace period active"
      };
    }
    if (verificationDeadline && nowDate > verificationDeadline) {
      return {
        action: "ESCALATE_MANUAL_REVIEW",
        eligibleForRelease: false,
        reason: "Verification grace period exceeded without provider resolution; escalate to manual review"
      };
    }
  }

  return { action: "NOOP", eligibleForRelease: false, reason: `Status '${payment.status}' has no pending expiry action` };
}

/**
 * Transfers payment allocation when a booking is rescheduled.
 * CRITICAL INVARIANT: payment.original_booking_id is NEVER rewritten!
 * Current allocation is managed strictly in `payment_allocations`.
 */
async function transferAllocationForReschedule(repository, {
  paymentId,
  fromBookingId,
  toBookingId,
  amount,
  now = new Date()
}) {
  return repository.transaction(async (tx) => {
    const payment = await (tx.getPaymentForUpdate?.(paymentId) ?? tx.getPaymentByIdForUpdate?.(paymentId) ?? tx.getPaymentById?.(paymentId));
    if (!payment) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Find active allocation for fromBookingId
    const allocations = await tx.getPaymentAllocations?.(paymentId) || [];
    const activeAlloc = allocations.find((a) => a.booking_id === fromBookingId && a.status === "active");

    if (!activeAlloc) {
      throw new Error(`No active payment allocation found for booking ${fromBookingId} under payment ${paymentId}`);
    }

    const transferAmount = amount ?? activeAlloc.amount;

    // Release/transfer old allocation
    await tx.updatePaymentAllocation?.(activeAlloc.id, {
      status: "transferred",
      released_at: now.toISOString(),
      metadata: { ...activeAlloc.metadata, transferred_to: toBookingId }
    });

    // Create new active allocation for rescheduled booking
    const newAlloc = await tx.insertPaymentAllocation({
      id: randomUUID(),
      payment_id: paymentId,
      booking_id: toBookingId,
      amount: transferAmount,
      allocation_type: "reschedule_transfer",
      status: "active",
      created_at: now.toISOString(),
      released_at: null,
      metadata: { transferred_from: fromBookingId }
    });

    // Append-only event
    await tx.insertPaymentEvent?.({
      id: randomUUID(),
      payment_id: paymentId,
      event_type: "allocation_transferred",
      from_status: payment.status,
      to_status: payment.status,
      actor: "system",
      reason_code: "BOOKING_RESCHEDULED",
      metadata: { from_booking_id: fromBookingId, to_booking_id: toBookingId, amount: transferAmount },
      created_at: now.toISOString()
    });

    return newAlloc;
  });
}

/**
 * Atomic Creation Service: Creates pending booking + payment + initial allocation
 * within a single database transaction scope.
 * 
 * Invariants:
 * - If booking cannot be created (slot conflict), payment is NEVER created.
 * - If payment or allocation creation fails, pending booking is ROLLED BACK.
 */
async function createPendingBookingWithPayment(repository, {
  customer,
  serviceId,
  staffId,
  startAt,
  servicePrice,
  source = "web",
  notes = null,
  paymentType,
  paymentPolicy,
  fixedAmount,
  percentage,
  provider = "promptpay_qr",
  idempotencyKey,
  now = new Date()
}) {
  return repository.transaction(async (tx) => {
    // 1. Lock schedule and check availability
    if (tx.lockStaffSchedule) {
      await tx.lockStaffSchedule(staffId);
    }
    const service = await tx.getActiveService(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found or inactive`);
    }

    const start = new Date(startAt);
    const end = new Date(start.getTime() + service.duration_minutes * 60 * 1000);
    const endAt = end.toISOString();

    if (tx.listBookingsForStaff) {
      const activeBookings = await tx.listBookingsForStaff(
        staffId,
        start,
        end,
        ["pending", "confirmed", "checked_in", "completed"]
      );
      if (activeBookings && activeBookings.length > 0) {
        throw new Error("requested slot is not available");
      }
    }

    // 2. Customer resolution
    let cust = customer.id ? customer : (tx.findCustomerByContact ? await tx.findCustomerByContact(customer) : null);
    if (!cust) {
      cust = await tx.insertCustomer(customer);
    }

    // 3. Insert pending booking
    const booking = await tx.insertBooking({
      customer_id: cust.id,
      service_id: serviceId,
      staff_id: staffId,
      start_at: startAt,
      end_at: endAt,
      status: "pending",
      source,
      notes
    });

    // 4. Insert initial booking status history
    if (tx.insertBookingStatusHistory) {
      await tx.insertBookingStatusHistory({
        booking_id: booking.id,
        from_status: "initial",
        to_status: "pending",
        reason: "pending_payment",
        changed_by: "customer",
        created_at: now.toISOString()
      });
    }

    // 5. Create payment linked to this booking
    const resolvedPrice = servicePrice !== undefined ? servicePrice : (service.price ?? 500);
    const resolvedPolicy = paymentPolicy || (paymentType ? {
      payment_type: paymentType,
      fixed_amount: fixedAmount,
      percentage
    } : undefined);

    const payment = await createPayment(tx, {
      bookingId: booking.id,
      servicePrice: resolvedPrice,
      servicePolicy: resolvedPolicy,
      provider,
      idempotencyKey: idempotencyKey || `pay_${booking.id}_init`,
      now
    });

    return {
      booking,
      payment
    };
  });
}

module.exports = {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  createPayment,
  createPendingBookingWithPayment,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule
};

