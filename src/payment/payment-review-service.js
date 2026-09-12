// Salon Booking OS v1 - Payment Manual Review Service
// Governs staff manual review lifecycle, atomic approval, rejection, and audit preservation.

const { randomUUID, createHash } = require("node:crypto");
const { PAYMENT_STATUSES } = require("./payment-state-machine");
const { sanitizePayload } = require("./data-safety");

class PaymentReviewError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PaymentReviewError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Computes a deterministic non-sensitive fingerprint of a transaction reference.
 * Prevents exposing raw transaction references in review UI summaries.
 */
function computeTransRefFingerprint(transRef) {
  if (!transRef || typeof transRef !== "string") return null;
  const hash = createHash("sha256").update(transRef.trim()).digest("hex").slice(0, 8);
  const suffix = transRef.trim().slice(-4);
  return `${hash}...${suffix}`;
}

/**
 * Masks bank account or PromptPay numbers for safe review display.
 */
function maskAccountNumber(account) {
  if (!account || typeof account !== "string") return null;
  const cleaned = account.trim();
  if (cleaned.length <= 4) return "****";
  const start = cleaned.slice(0, 3);
  const end = cleaned.slice(-3);
  return `${start}-xxx-${end}`;
}

/**
 * Executes atomic approval of a payment currently in manual_review.
 * 
 * Invariants:
 * 1. Executes inside a single database transaction with SELECT ... FOR UPDATE.
 * 2. Locks payment first, then booking, adhering to lock hierarchy.
 * 3. Validates payment is in manual_review and booking is pending.
 * 4. Checks slot schedule: if slot was claimed by another booking or booking expired,
 *    fails closed with MANUAL_REVIEW_LATE_PAYMENT without reclaiming the slot.
 * 5. Validates payment attempts evidence exists.
 * 6. Updates payment -> paid, booking -> confirmed.
 * 7. Inserts immutable audit records: booking status history, payment event, and confirmation outbox job.
 * 8. Idempotent: re-approving an already approved review returns success without re-creating side effects.
 */
async function approvePaymentReview(repository, {
  tenantId = "default",
  paymentId,
  reviewedBy,
  notes = null,
  now = new Date()
}) {
  if (!reviewedBy) {
    throw new PaymentReviewError("Staff identity (reviewedBy) is required for manual approval", "STAFF_IDENTITY_REQUIRED");
  }

  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const nowDate = now instanceof Date ? now : new Date(now);

  return repository.transaction(async (tx) => {
    // 1. Lock payment
    const payment = await tx.getPaymentForUpdate(paymentId);
    if (!payment) {
      throw new PaymentReviewError(`Payment ${paymentId} not found`, "PAYMENT_NOT_FOUND");
    }

    // 2. Idempotency Check: if already paid & approved by staff, return idempotent success
    if (payment.status === PAYMENT_STATUSES.paid) {
      if (payment.review_status === "approved" || payment.reviewed_by) {
        const existingBooking = await tx.getBookingById(payment.original_booking_id);
        return {
          status: "already_approved",
          idempotent: true,
          payment,
          booking: existingBooking
        };
      }
      throw new PaymentReviewError(
        `Payment ${paymentId} is already paid through an automated or alternative channel`,
        "PAYMENT_ALREADY_PAID"
      );
    }

    // 3. Status Check: Must be in manual_review
    if (payment.status !== PAYMENT_STATUSES.manualReview) {
      throw new PaymentReviewError(
        `Payment ${paymentId} is in status '${payment.status}' and cannot be approved via manual review`,
        "INVALID_PAYMENT_STATUS"
      );
    }

    // 4. Lock booking
    const booking = await tx.getBookingForUpdate(payment.original_booking_id);
    if (!booking) {
      throw new PaymentReviewError(`Booking ${payment.original_booking_id} not found`, "BOOKING_NOT_FOUND");
    }

    // 5. Booking Status Check: Late Payment / Slot Safety
    if (booking.status === "expired" || booking.status === "cancelled") {
      throw new PaymentReviewError(
        `Booking ${booking.id} is '${booking.status}'; expired bookings cannot be confirmed by staff review`,
        "MANUAL_REVIEW_LATE_PAYMENT",
        { bookingId: booking.id, bookingStatus: booking.status }
      );
    }

    if (booking.status !== "pending") {
      throw new PaymentReviewError(
        `Booking ${booking.id} in status '${booking.status}' cannot be confirmed via review`,
        "INVALID_BOOKING_STATUS",
        { bookingId: booking.id, bookingStatus: booking.status }
      );
    }

    // 6. Slot Schedule Safety: Ensure stylist schedule is not occupied by another active booking
    if (tx.findConflictingActiveBooking) {
      const conflicting = await tx.findConflictingActiveBooking(
        booking.staff_id,
        booking.start_at,
        booking.end_at,
        booking.id
      );
      if (conflicting) {
        throw new PaymentReviewError(
          `Staff slot has been claimed by another active booking (${conflicting.id}); cannot confirm`,
          "MANUAL_REVIEW_LATE_PAYMENT",
          { conflictingBookingId: conflicting.id }
        );
      }
    }

    // 7. Verify Payment Attempts Evidence
    const attempts = await (tx.getPaymentAttempts ? tx.getPaymentAttempts(payment.id) : []);
    if (!attempts || attempts.length === 0) {
      throw new PaymentReviewError(
        "No payment attempt evidence recorded for this payment",
        "NO_PAYMENT_EVIDENCE"
      );
    }

    // Determine verified amount from latest attempt or amount_due
    const latestAttempt = attempts[attempts.length - 1];
    const verifiedAmount = latestAttempt.verified_amount ?? payment.amount_due;

    // 8. Update Payment: paid, review_status = 'approved'
    const updatedPayment = await tx.updatePayment(payment.id, {
      status: PAYMENT_STATUSES.paid,
      amount_paid: verifiedAmount,
      paid_at: timestamp,
      reviewed_by: reviewedBy,
      reviewed_at: timestamp,
      review_status: "approved",
      review_reason: notes ?? "staff_manual_approval",
      updated_at: timestamp
    });

    // 9. Update Booking: confirmed
    const updatedBooking = await tx.updateBookingStatus(booking.id, "confirmed");

    // 10. Record Booking Status History
    if (tx.insertBookingStatusHistory) {
      await tx.insertBookingStatusHistory({
        id: randomUUID(),
        booking_id: booking.id,
        from_status: booking.status,
        to_status: "confirmed",
        reason: "staff_manual_approval",
        changed_by: reviewedBy,
        created_at: timestamp
      });
    }

    // 11. Maintain active payment allocation
    const allocations = await (tx.getPaymentAllocations ? tx.getPaymentAllocations(payment.id) : []);
    let activeAlloc = allocations.find((a) => a.booking_id === booking.id && a.status === "active");
    if (!activeAlloc && tx.insertPaymentAllocation) {
      activeAlloc = await tx.insertPaymentAllocation({
        id: randomUUID(),
        payment_id: payment.id,
        booking_id: booking.id,
        amount: verifiedAmount,
        allocation_type: "initial",
        status: "active",
        created_at: timestamp,
        released_at: null,
        metadata: { source: "staff_manual_review", reviewed_by: reviewedBy }
      });
    }

    // 12. Insert Append-Only Payment Event Audit
    if (tx.insertPaymentEvent) {
      await tx.insertPaymentEvent({
        id: randomUUID(),
        payment_id: payment.id,
        event_type: "payment_confirmed",
        from_status: payment.status,
        to_status: PAYMENT_STATUSES.paid,
        actor: reviewedBy,
        reason_code: "STAFF_MANUAL_APPROVAL",
        metadata: {
          source_of_confirmation: "staff_manual_review",
          reviewed_by: reviewedBy,
          amount_paid: verifiedAmount,
          notes: notes ?? null,
          booking_id: booking.id
        },
        created_at: timestamp
      });
    }

    // 13. Create Confirmation Outbox Job (Asynchronous LINE notification)
    if (tx.enqueueAutomationJob) {
      await tx.enqueueAutomationJob({
        booking_id: booking.id,
        automation_type: "booking_confirmation",
        event_key: `booking-confirmed:${booking.id}:review_${payment.id}`,
        scheduled_at: timestamp,
        payload: {
          booking_id: booking.id,
          payment_id: payment.id,
          amount_paid: verifiedAmount,
          source_of_confirmation: "staff_manual_review",
          currency: payment.currency || "THB"
        }
      });
    }

    return {
      status: "approved",
      idempotent: false,
      payment: updatedPayment,
      booking: updatedBooking,
      allocation: activeAlloc
    };
  });
}

/**
 * Rejects a payment currently in manual_review.
 * 
 * Invariants:
 * 1. Executes inside transaction with SELECT ... FOR UPDATE.
 * 2. Updates payment -> verification_failed.
 * 3. Records review_status: 'rejected', reviewed_by, reviewed_at, and reason_code.
 * 4. Retains payment attempts and evidence immutably.
 * 5. Booking remains pending if within payment window, or transitions to expired if specified.
 * 6. Idempotent: repeat rejections return already_rejected without duplicate side effects.
 */
async function rejectPaymentReview(repository, {
  tenantId = "default",
  paymentId,
  reviewedBy,
  reasonCode = "STAFF_MANUAL_REJECTION",
  notes = null,
  expireBooking = false,
  now = new Date()
}) {
  if (!reviewedBy) {
    throw new PaymentReviewError("Staff identity (reviewedBy) is required for manual rejection", "STAFF_IDENTITY_REQUIRED");
  }

  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const nowDate = now instanceof Date ? now : new Date(now);

  return repository.transaction(async (tx) => {
    // 1. Lock payment
    const payment = await tx.getPaymentForUpdate(paymentId);
    if (!payment) {
      throw new PaymentReviewError(`Payment ${paymentId} not found`, "PAYMENT_NOT_FOUND");
    }

    // 2. Idempotency Check: if already rejected, return idempotent result
    if (payment.status === PAYMENT_STATUSES.verificationFailed && payment.review_status === "rejected") {
      const existingBooking = await tx.getBookingById(payment.original_booking_id);
      return {
        status: "already_rejected",
        idempotent: true,
        payment,
        booking: existingBooking
      };
    }

    if (payment.status !== PAYMENT_STATUSES.manualReview) {
      throw new PaymentReviewError(
        `Payment ${paymentId} is in status '${payment.status}' and cannot be rejected via manual review`,
        "INVALID_PAYMENT_STATUS"
      );
    }

    // 3. Lock booking
    const booking = await tx.getBookingForUpdate(payment.original_booking_id);
    if (!booking) {
      throw new PaymentReviewError(`Booking ${payment.original_booking_id} not found`, "BOOKING_NOT_FOUND");
    }

    // 4. Update Payment to verification_failed
    const updatedPayment = await tx.updatePayment(payment.id, {
      status: PAYMENT_STATUSES.verificationFailed,
      reviewed_by: reviewedBy,
      reviewed_at: timestamp,
      review_status: "rejected",
      review_reason: notes ? `${reasonCode}: ${notes}` : reasonCode,
      updated_at: timestamp
    });

    // 5. Booking Handling: expire if requested or if payment deadline has passed
    let updatedBooking = booking;
    const isPastExpiry = payment.expires_at && new Date(payment.expires_at) < nowDate;
    if (expireBooking || isPastExpiry) {
      if (booking.status === "pending") {
        updatedBooking = await tx.updateBookingStatus(booking.id, "expired");
        if (tx.insertBookingStatusHistory) {
          await tx.insertBookingStatusHistory({
            id: randomUUID(),
            booking_id: booking.id,
            from_status: booking.status,
            to_status: "expired",
            reason: "payment_review_rejected",
            changed_by: reviewedBy,
            created_at: timestamp
          });
        }
      }
    }

    // 6. Insert Append-Only Payment Event Audit
    if (tx.insertPaymentEvent) {
      await tx.insertPaymentEvent({
        id: randomUUID(),
        payment_id: payment.id,
        event_type: "verification_failed",
        from_status: payment.status,
        to_status: PAYMENT_STATUSES.verificationFailed,
        actor: reviewedBy,
        reason_code: reasonCode,
        metadata: {
          source: "staff_manual_review",
          reviewed_by: reviewedBy,
          notes: notes ?? null,
          booking_id: booking.id
        },
        created_at: timestamp
      });
    }

    // 7. Enqueue Notification Job for Customer
    if (tx.enqueueAutomationJob) {
      await tx.enqueueAutomationJob({
        booking_id: booking.id,
        automation_type: "payment_review_rejected",
        event_key: `payment-review-rejected:${payment.id}`,
        scheduled_at: timestamp,
        payload: {
          booking_id: booking.id,
          payment_id: payment.id,
          reason_code: reasonCode,
          notes: notes ?? null,
          message: "ร้านยังไม่สามารถยืนยันการชำระเงินรายการนี้ได้ค่ะ"
        }
      });
    }

    return {
      status: "rejected",
      idempotent: false,
      payment: updatedPayment,
      booking: updatedBooking
    };
  });
}

/**
 * Returns safe sanitized payment review detail for admin review UI.
 * Strips all internal secrets, raw auth tokens, and full account numbers.
 */
async function getPaymentReviewDetails(repository, { paymentId }) {
  const payment = await repository.getPaymentById(paymentId);
  if (!payment) {
    throw new PaymentReviewError(`Payment ${paymentId} not found`, "PAYMENT_NOT_FOUND");
  }

  const booking = await repository.getBookingById(payment.original_booking_id);
  const attempts = await (repository.getPaymentAttempts ? repository.getPaymentAttempts(payment.id) : []);

  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

  // Calculate age
  const createdAtMs = new Date(payment.created_at).getTime();
  const ageMinutes = Math.max(0, Math.floor((Date.now() - createdAtMs) / (60 * 1000)));

  // Amount match
  const expectedSatang = Math.round(Number(payment.amount_due) * 100);
  const verifiedSatang = latestAttempt?.verified_amount !== null && latestAttempt?.verified_amount !== undefined
    ? Math.round(Number(latestAttempt.verified_amount) * 100)
    : null;
  const amountMatch = verifiedSatang !== null ? expectedSatang === verifiedSatang : null;

  // Receiver match summary
  let receiverMatchStatus = "UNKNOWN";
  if (latestAttempt) {
    if (latestAttempt.normalized_result === "receiver_mismatch") {
      receiverMatchStatus = "MISMATCH";
    } else if (latestAttempt.failure_reason_code === "INSUFFICIENT_RECEIVER_DATA") {
      receiverMatchStatus = "INSUFFICIENT";
    } else if (latestAttempt.verified_receiver) {
      receiverMatchStatus = "MATCH";
    }
  }

  // Duplicate signal
  const duplicateSignal = latestAttempt
    ? latestAttempt.normalized_result === "duplicate" ||
      latestAttempt.failure_reason_code === "DUPLICATE_SLIP" ||
      latestAttempt.provider_status === "DUPLICATE"
    : false;

  // Sanitized attempts history
  const sanitizedAttempts = attempts.map((att) => ({
    id: att.id,
    attempt_type: att.attempt_type,
    verification_provider: att.verification_provider,
    normalized_result: att.normalized_result,
    verified_amount: att.verified_amount,
    verified_receiver: maskAccountNumber(att.verified_receiver),
    verified_sender: maskAccountNumber(att.verified_sender),
    trans_ref_fingerprint: computeTransRefFingerprint(att.verified_transaction_reference),
    verified_transaction_at: att.verified_transaction_at,
    failure_reason_code: att.failure_reason_code,
    created_at: att.created_at
  }));

  return {
    payment_id: payment.id,
    business_id: payment.business_id,
    status: payment.status,
    review_status: payment.review_status ?? "pending",
    review_reason: payment.review_reason ?? null,
    reviewed_by: payment.reviewed_by ?? null,
    reviewed_at: payment.reviewed_at ?? null,
    amount_due: payment.amount_due,
    amount_paid: payment.amount_paid,
    currency: payment.currency,
    provider: payment.provider,
    expires_at: payment.expires_at,
    manual_review_deadline: payment.manual_review_deadline,
    payment_created_at: payment.created_at,
    payment_age_minutes: ageMinutes,
    booking: booking ? {
      id: booking.id,
      reference: `#${String(booking.id).slice(0, 8).toUpperCase()}`,
      status: booking.status,
      start_at: booking.start_at,
      end_at: booking.end_at,
      service_id: booking.service_id,
      staff_id: booking.staff_id,
      customer_id: booking.customer_id
    } : null,
    evidence: {
      expected_amount: payment.amount_due,
      verified_amount: latestAttempt?.verified_amount ?? null,
      amount_match: amountMatch,
      receiver_match_status: receiverMatchStatus,
      trans_ref_fingerprint: computeTransRefFingerprint(latestAttempt?.verified_transaction_reference),
      transaction_timestamp: latestAttempt?.verified_transaction_at ?? null,
      provider: latestAttempt?.verification_provider ?? payment.provider,
      duplicate_signal: duplicateSignal,
      attempts_count: attempts.length
    },
    attempts: sanitizedAttempts
  };
}

module.exports = {
  PaymentReviewError,
  computeTransRefFingerprint,
  maskAccountNumber,
  approvePaymentReview,
  rejectPaymentReview,
  getPaymentReviewDetails
};
