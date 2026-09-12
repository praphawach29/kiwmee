// Salon Booking OS v1 - Payment Service
// Domain operations for payment creation, slip evaluation, allocation, and verification grace

const { randomUUID } = require("node:crypto");
const { PAYMENT_STATUSES, validateTransition } = require("./payment-state-machine");
const { calculatePricing } = require("./pricing-calculator");
const { PAYMENT_REASON_CODES } = require("./reason-codes");
const { ReceiverMatcher, RECEIVER_MATCH_STATUS } = require("./receiver-matcher");
const { validateTransactionTime } = require("./transaction-time-validator");
const { hasRequiredAutoConfirmCapabilities } = require("./providers/authoritative-slip-provider");

const DEFAULT_PAYMENT_EXPIRY_MINUTES = 15;
const DEFAULT_VERIFICATION_GRACE_MINUTES = 10;
const DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES = 15;

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
 * Evaluates amount verification, authoritative status, receiver matching, and timing according to domain policy.
 * AI/OCR is never authoritative; strict normalized comparison against expected payment parameters.
 */
function evaluateSlipVerification({ payment, verificationResult, expectedReceiver, options = {} }) {
  if (!verificationResult || verificationResult.normalized_result === "invalid_slip") {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: PAYMENT_REASON_CODES.INVALID_SLIP,
      description: "Slip could not be read or decoded"
    };
  }

  if (verificationResult.normalized_result === "duplicate") {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION,
      description: "Slip has already been used for another payment"
    };
  }

  // 1. Provider Capabilities Check
  const capabilitiesToCheck = options.capabilities || verificationResult.capabilities;
  if (capabilitiesToCheck && !hasRequiredAutoConfirmCapabilities(capabilitiesToCheck)) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: PAYMENT_REASON_CODES.INSUFFICIENT_PROVIDER_CAPABILITY,
      description: "Provider lacks required capabilities (transactionRef, amount, receiver, transactionTime) for auto-confirmation"
    };
  }

  // 2. Receiver Matching via ReceiverMatcher
  const expectedRec = expectedReceiver || payment.business_id;
  const verifiedRec = verificationResult.receiver || verificationResult.verified_receiver;

  if (expectedRec && verifiedRec) {
    const matchResult = ReceiverMatcher.match(expectedRec, verifiedRec);
    if (matchResult.status === RECEIVER_MATCH_STATUS.MISMATCH) {
      return {
        eligibleForAutoConfirmation: false,
        recommendedStatus: PAYMENT_STATUSES.manualReview,
        reasonCode: PAYMENT_REASON_CODES.RECEIVER_MISMATCH,
        description: `Receiver does not match expected merchant account (${matchResult.reason})`
      };
    }
    if (matchResult.status === RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA) {
      return {
        eligibleForAutoConfirmation: false,
        recommendedStatus: PAYMENT_STATUSES.manualReview,
        reasonCode: PAYMENT_REASON_CODES.INSUFFICIENT_RECEIVER_DATA,
        description: `Receiver data insufficient for automated confirmation (${matchResult.reason})`
      };
    }
  }

  // 3. Strict Amount Verification
  const verifiedSatang = verificationResult.amountSatang !== undefined
    ? Number(verificationResult.amountSatang)
    : Math.round(Number(verificationResult.verified_amount || 0) * 100);
  const dueSatang = Math.round(Number(payment.amount_due) * 100);

  if (verifiedSatang < dueSatang) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: PAYMENT_REASON_CODES.AMOUNT_MISMATCH_UNDERPAID,
      description: `Verified amount (${verifiedSatang / 100}) is less than amount due (${payment.amount_due})`
    };
  }

  if (verifiedSatang > dueSatang) {
    // Overpayment (verifiedSatang > dueSatang) -> manual review, never auto-paid
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: PAYMENT_REASON_CODES.OVERPAYMENT_MANUAL_REVIEW,
      description: `Verified amount (${verifiedSatang / 100}) exceeds amount due (${payment.amount_due})`
    };
  }

  // 4. Authoritative Gate: verified=true is NOT enough, MUST have authoritative=true
  if (verificationResult.authoritative !== true) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: PAYMENT_REASON_CODES.NON_AUTHORITATIVE_VERIFICATION,
      description: "Slip verification is non-authoritative (OCR/AI); requires manual review before confirmation"
    };
  }

  if (verificationResult.verified !== true) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.verificationFailed,
      reasonCode: verificationResult.reasonCode || PAYMENT_REASON_CODES.INVALID_SLIP,
      description: "Slip could not be verified by provider"
    };
  }

  // 5. Mandatory Transaction Time Validation for Authoritative Verified Slips
  const txnAt = verificationResult.transactionAt || verificationResult.verified_transaction_at;
  if (!txnAt) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: PAYMENT_REASON_CODES.MISSING_TRANSACTION_TIME,
      description: "Authoritative verification is missing required transaction timestamp"
    };
  }

  const txnDate = txnAt instanceof Date ? txnAt : new Date(txnAt);
  if (Number.isNaN(txnDate.getTime())) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: PAYMENT_REASON_CODES.INVALID_TRANSACTION_TIME,
      description: "Transaction timestamp format is invalid"
    };
  }

  const timeRes = validateTransactionTime({ payment, transactionAt: txnDate, options });
  if (!timeRes.valid) {
    return {
      eligibleForAutoConfirmation: false,
      recommendedStatus: PAYMENT_STATUSES.manualReview,
      reasonCode: timeRes.reasonCode,
      description: timeRes.description
    };
  }

  // Exact amount, matching receiver, valid timing, and authoritative verification
  return {
    eligibleForAutoConfirmation: true,
    recommendedStatus: PAYMENT_STATUSES.paid,
    reasonCode: PAYMENT_REASON_CODES.EXACT_AMOUNT_MATCH,
    description: "Verified amount matches amount due exactly"
  };
}

/**
 * Pure domain logic for checking verification grace periods and manual review deadlines.
 * Rules:
 * - pending + expires_at passed => EXPIRE
 * - slip_received/verifying + expires_at passed, but verification_deadline NOT passed => WAIT_GRACE (not expired!)
 * - verifying + verification_deadline passed => ESCALATE_MANUAL_REVIEW
 * - manual_review + before manual_review_deadline => HOLD_FOR_REVIEW
 * - manual_review + manual_review_deadline passed => MANUAL_REVIEW_EXPIRED
 */
function evaluateVerificationGrace(payment, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const expiresAt = new Date(payment.expires_at);
  const verificationDeadline = payment.verification_deadline ? new Date(payment.verification_deadline) : null;
  const manualReviewDeadline = payment.manual_review_deadline ? new Date(payment.manual_review_deadline) : null;

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

  if (payment.status === PAYMENT_STATUSES.manualReview) {
    if (manualReviewDeadline) {
      if (nowDate <= manualReviewDeadline) {
        return {
          action: "HOLD_FOR_REVIEW",
          eligibleForRelease: false,
          reason: "Manual review deadline active; holding slot for operator review"
        };
      }
      return {
        action: "MANUAL_REVIEW_EXPIRED",
        eligibleForRelease: true,
        reason: "Manual review deadline exceeded without operator resolution"
      };
    }
    // If manual_review_deadline was not explicitly stored, compute default relative to updated_at
    const baseline = new Date(payment.updated_at || payment.created_at || nowDate);
    const implicitDeadline = new Date(baseline.getTime() + DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES * 60 * 1000);
    if (nowDate <= implicitDeadline) {
      return {
        action: "HOLD_FOR_REVIEW",
        eligibleForRelease: false,
        reason: "Implicit manual review deadline active; holding slot for operator review"
      };
    }
    return {
      action: "MANUAL_REVIEW_EXPIRED",
      eligibleForRelease: true,
      reason: "Implicit manual review deadline exceeded without operator resolution"
    };
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
  service_id,
  staffId,
  staff_id,
  startAt,
  start_at,
  servicePrice,
  source = "web",
  notes = null,
  paymentType,
  paymentPolicy,
  fixedAmount,
  percentage,
  provider = "promptpay_qr",
  idempotencyKey,
  expiryMinutes = DEFAULT_PAYMENT_EXPIRY_MINUTES,
  now = new Date()
}) {
  const effectiveServiceId = serviceId ?? service_id;
  const effectiveStaffId = staffId ?? staff_id;
  const effectiveStartAt = startAt ?? start_at;

  return repository.transaction(async (tx) => {
    // 1. Lock schedule and check availability
    if (tx.lockStaffSchedule) {
      await tx.lockStaffSchedule(effectiveStaffId);
    }
    const service = await tx.getActiveService(effectiveServiceId);
    if (!service) {
      throw new Error(`Service ${effectiveServiceId} not found or inactive`);
    }

    const start = new Date(effectiveStartAt);
    const end = new Date(start.getTime() + service.duration_minutes * 60 * 1000);
    const endAt = end.toISOString();

    if (tx.listBookingsForStaff) {
      const activeBookings = await tx.listBookingsForStaff(
        effectiveStaffId,
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

    // 3. Insert pending booking (subject to GiST exclusion constraint on active/pending bookings)
    const booking = await tx.insertBooking({
      customer_id: cust.id,
      service_id: effectiveServiceId,
      staff_id: effectiveStaffId,
      start_at: effectiveStartAt,
      end_at: endAt,
      status: "pending",
      source,
      notes,
      checkout_idempotency_key: idempotencyKey ?? null
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
      expiryMinutes,
      now
    });

    return {
      booking,
      payment
    };
  });
}

/**
 * Expiry Service: Evaluates and handles payment hold expiry within an atomic transaction.
 * 
 * Strict Financial Lock Ordering Hierarchy:
 * 1. Lock payment row FOR UPDATE
 * 2. Lock booking row FOR UPDATE
 * 3. Lock/Release payment allocations
 * 
 * Rules:
 * - pending + now <= expires_at => HOLD (slot held)
 * - pending + now > expires_at => EXPIRE (payment -> expired, booking -> expired, allocations released, slot freed)
 * - slip_received/verifying + now <= verification_deadline => WAIT_GRACE (hold slot through grace period)
 * - verifying + now > verification_deadline => MANUAL_REVIEW (escalate to human review, do not auto-cancel)
 */
async function expirePendingPaymentHold(repository, { paymentId, bookingId, now = new Date() }) {
  const nowDate = now instanceof Date ? now : new Date(now);

  return repository.transaction(async (tx) => {
    // 1. Lock payment first (financial lock ordering: payment -> booking -> allocation)
    let payment = null;
    if (paymentId) {
      payment = await (
        tx.getPaymentForUpdate?.(paymentId) ??
        tx.getPaymentByIdForUpdate?.(paymentId) ??
        tx.getPaymentById?.(paymentId)
      );
    } else if (bookingId) {
      const payments = await (
        tx.getPaymentsByBookingId?.(bookingId) ??
        tx.findPaymentByBookingId?.(bookingId) ??
        []
      );
      const matched = Array.isArray(payments) ? payments[0] : payments;
      if (matched) {
        payment = await (
          tx.getPaymentForUpdate?.(matched.id) ??
          tx.getPaymentByIdForUpdate?.(matched.id) ??
          tx.getPaymentById?.(matched.id)
        );
      }
    }

    if (!payment) {
      throw new Error(`Payment not found for expiry evaluation`);
    }

    // 2. Lock booking second
    const targetBookingId = bookingId || payment.original_booking_id;
    const booking = await (
      tx.getBookingForUpdate?.(targetBookingId) ??
      tx.getBookingByIdForUpdate?.(targetBookingId) ??
      tx.getBooking?.(targetBookingId) ??
      tx.getBookingById?.(targetBookingId)
    );
    if (!booking) {
      throw new Error(`Booking ${targetBookingId} not found for payment ${payment.id}`);
    }

    // 3. Evaluate grace and expiry rules
    const graceEvaluation = evaluateVerificationGrace(payment, nowDate);

    // Rule: pending before expiry -> HOLD
    if (graceEvaluation.action === "ACTIVE") {
      return {
        status: "HOLD",
        action: "HOLD",
        reason: "Payment window active; slot held",
        paymentId: payment.id,
        bookingId: booking.id,
        expiresAt: payment.expires_at
      };
    }

    // Rule: slip_received or verifying within verification_deadline -> WAIT_GRACE
    if (graceEvaluation.action === "WAIT_GRACE") {
      return {
        status: "WAIT_GRACE",
        action: "WAIT_GRACE",
        reason: "Verification grace period active; hold slot through verification deadline",
        paymentId: payment.id,
        bookingId: booking.id,
        verificationDeadline: payment.verification_deadline
      };
    }

    // Rule: verifying past verification_deadline -> ESCALATE_MANUAL_REVIEW
    if (graceEvaluation.action === "ESCALATE_MANUAL_REVIEW") {
      const manualReviewDeadline = new Date(nowDate.getTime() + DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES * 60 * 1000).toISOString();

      await (
        tx.updatePaymentStatus?.(payment.id, PAYMENT_STATUSES.manualReview, {
          reason: "VERIFICATION_GRACE_EXCEEDED",
          manual_review_deadline: manualReviewDeadline
        }) ??
        tx.updatePayment?.(payment.id, {
          status: PAYMENT_STATUSES.manualReview,
          manual_review_deadline: manualReviewDeadline,
          updated_at: nowDate.toISOString()
        })
      );

      await tx.insertPaymentEvent?.({
        id: randomUUID(),
        payment_id: payment.id,
        event_type: "manual_review_requested",
        from_status: payment.status,
        to_status: PAYMENT_STATUSES.manualReview,
        actor: "system",
        reason_code: "VERIFICATION_GRACE_EXCEEDED",
        metadata: {
          verification_deadline: payment.verification_deadline,
          manual_review_deadline: manualReviewDeadline,
          evaluated_at: nowDate.toISOString()
        },
        created_at: nowDate.toISOString()
      });

      return {
        status: "MANUAL_REVIEW",
        action: "MANUAL_REVIEW",
        reason: "Verification grace period exceeded without provider resolution; escalated to manual review",
        paymentId: payment.id,
        bookingId: booking.id,
        manualReviewDeadline
      };
    }

    // Rule: manual_review before manual_review_deadline -> HOLD_FOR_REVIEW
    if (graceEvaluation.action === "HOLD_FOR_REVIEW") {
      return {
        status: "HOLD_FOR_REVIEW",
        action: "HOLD_FOR_REVIEW",
        reason: "Manual review deadline active; holding slot for operator review",
        paymentId: payment.id,
        bookingId: booking.id,
        manualReviewDeadline: payment.manual_review_deadline ?? null
      };
    }

    // Rule: manual_review past manual_review_deadline -> MANUAL_REVIEW_EXPIRED
    if (graceEvaluation.action === "MANUAL_REVIEW_EXPIRED") {
      return {
        status: "MANUAL_REVIEW_EXPIRED",
        action: "MANUAL_REVIEW_EXPIRED",
        reason: "Manual review deadline exceeded; deterministic action available for operator",
        paymentId: payment.id,
        bookingId: booking.id,
        manualReviewDeadline: payment.manual_review_deadline ?? null
      };
    }

    // Rule: pending past expires_at -> EXPIRE
    if (graceEvaluation.action === "EXPIRE") {
      // 1. Transition payment to expired
      await (
        tx.updatePaymentStatus?.(payment.id, PAYMENT_STATUSES.expired, {
          reason: "PAYMENT_HOLD_EXPIRED"
        }) ??
        tx.updatePayment?.(payment.id, {
          status: PAYMENT_STATUSES.expired,
          updated_at: nowDate.toISOString()
        })
      );

      // 2. Transition booking to expired (frees GiST constraint and availability engine)
      await (
        tx.updateBookingStatus?.(booking.id, "expired") ??
        tx.updateBooking?.(booking.id, {
          status: "expired",
          updated_at: nowDate.toISOString()
        })
      );

      // 3. Release active payment allocations
      const allocations = await (tx.getPaymentAllocations?.(payment.id) ?? []);
      for (const alloc of allocations) {
        if (alloc.status === "active") {
          await (
            tx.updatePaymentAllocation?.(alloc.id, {
              status: "released",
              released_at: nowDate.toISOString(),
              metadata: { release_reason: "payment_hold_expired" }
            })
          );
        }
      }

      // 4. Record append-only payment audit event
      await tx.insertPaymentEvent?.({
        id: randomUUID(),
        payment_id: payment.id,
        event_type: "payment_expired",
        from_status: payment.status,
        to_status: PAYMENT_STATUSES.expired,
        actor: "system",
        reason_code: "PAYMENT_HOLD_EXPIRED",
        metadata: {
          expires_at: payment.expires_at,
          expired_at: nowDate.toISOString()
        },
        created_at: nowDate.toISOString()
      });

      // 5. Record booking status history
      await tx.insertBookingStatusHistory?.({
        id: randomUUID(),
        booking_id: booking.id,
        from_status: booking.status,
        to_status: "expired",
        reason: "payment hold expired",
        changed_by: "system",
        created_at: nowDate.toISOString()
      });

      return {
        status: "EXPIRE",
        action: "EXPIRE",
        reason: "Payment window expired without slip; slot released",
        paymentId: payment.id,
        bookingId: booking.id
      };
    }

    return {
      status: "NOOP",
      action: "NOOP",
      reason: `Status '${payment.status}' has no pending expiry action`,
      paymentId: payment.id,
      bookingId: booking.id
    };
  });
}

module.exports = {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES,
  createPayment,
  createPendingBookingWithPayment,
  expirePendingPaymentHold,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule
};

