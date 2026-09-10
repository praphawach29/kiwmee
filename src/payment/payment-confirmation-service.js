// Salon Booking OS v1 - Payment Confirmation Service
// Executes atomic financial and booking confirmation transactions

const { randomUUID } = require("node:crypto");
const { PAYMENT_STATUSES, validateTransition } = require("./payment-state-machine");

class PaymentConfirmationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PaymentConfirmationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Executes atomic confirmation of a verified payment and its associated booking.
 * 
 * Invariant: All mutations occur within a single database transaction scope.
 * If any step fails, the entire transaction rolls back.
 * The Automation Worker NEVER alters payment/booking financial state directly.
 */
async function confirmVerifiedPayment(repository, {
  paymentId,
  verifiedAmount,
  transactionNamespace,
  transactionReference,
  actor = "system",
  now = new Date()
}) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return repository.transaction(async (tx) => {
    // 1. Lock/load payment
    const payment = await tx.getPaymentForUpdate(paymentId);
    if (!payment) {
      throw new PaymentConfirmationError(`Payment ${paymentId} not found`, "PAYMENT_NOT_FOUND");
    }

    // 2. Check Idempotency: if already paid with same reference, return idempotent success
    if (payment.status === PAYMENT_STATUSES.paid) {
      if (payment.transaction_reference === transactionReference) {
        return {
          status: "idempotent_success",
          paymentId: payment.id,
          bookingId: payment.original_booking_id,
          idempotent: true
        };
      }
      throw new PaymentConfirmationError(
        `Payment ${paymentId} is already paid with a different transaction reference`,
        "PAYMENT_ALREADY_PAID_DIFFERENT_REFERENCE"
      );
    }

    // 3. Validate payment state transition to 'paid'
    validateTransition(payment.status, PAYMENT_STATUSES.paid);

    // 4. Lock/load booking
    const booking = await tx.getBookingForUpdate(payment.original_booking_id);
    if (!booking) {
      throw new PaymentConfirmationError(`Booking ${payment.original_booking_id} not found`, "BOOKING_NOT_FOUND");
    }
    if (!["pending", "confirmed"].includes(booking.status)) {
      throw new PaymentConfirmationError(
        `Booking ${booking.id} in status '${booking.status}' cannot be confirmed by payment`,
        "INVALID_BOOKING_STATUS"
      );
    }

    // 5. Validate exact financial amount
    const verifiedSatang = Math.round(Number(verifiedAmount) * 100);
    const dueSatang = Math.round(Number(payment.amount_due) * 100);
    if (verifiedSatang !== dueSatang) {
      throw new PaymentConfirmationError(
        `Verified amount (${verifiedAmount}) does not match amount due (${payment.amount_due})`,
        "AMOUNT_MISMATCH",
        { verifiedAmount, amountDue: payment.amount_due }
      );
    }

    // 6. Validate transaction identity & replay protection across all payments
    if (transactionNamespace && transactionReference && tx.findPaymentByTransaction) {
      const existingTxn = await tx.findPaymentByTransaction(transactionNamespace, transactionReference);
      if (existingTxn && existingTxn.id !== payment.id) {
        throw new PaymentConfirmationError(
          `Transaction reference '${transactionReference}' in namespace '${transactionNamespace}' has already been redeemed`,
          "TRANSACTION_ALREADY_REDEEMED",
          { existingPaymentId: existingTxn.id }
        );
      }
    }

    // 7. Mark Payment as PAID
    const updatedPayment = await tx.updatePayment(payment.id, {
      status: PAYMENT_STATUSES.paid,
      amount_paid: verifiedAmount,
      paid_at: timestamp,
      transaction_namespace: transactionNamespace,
      transaction_reference: transactionReference,
      updated_at: timestamp
    });

    // 8. Mark Booking as CONFIRMED
    const updatedBooking = await tx.updateBookingStatus(booking.id, "confirmed");

    // 9. Record Booking Status History
    await tx.insertBookingStatusHistory({
      id: randomUUID(),
      booking_id: booking.id,
      from_status: booking.status,
      to_status: "confirmed",
      reason: "payment_confirmed",
      changed_by: actor,
      created_at: timestamp
    });

    // 10. Ensure Active Payment Allocation exists
    const allocations = await tx.getPaymentAllocations?.(payment.id) || [];
    let activeAlloc = allocations.find((a) => a.booking_id === booking.id && a.status === "active");
    if (!activeAlloc) {
      activeAlloc = await tx.insertPaymentAllocation({
        id: randomUUID(),
        payment_id: payment.id,
        booking_id: booking.id,
        amount: verifiedAmount,
        allocation_type: "initial",
        status: "active",
        created_at: timestamp,
        released_at: null,
        metadata: { source: "confirmation_service" }
      });
    }

    // 11. Record Immutable Audit Event
    await tx.insertPaymentEvent({
      id: randomUUID(),
      payment_id: payment.id,
      event_type: "payment_confirmed",
      from_status: payment.status,
      to_status: PAYMENT_STATUSES.paid,
      actor,
      reason_code: "EXACT_VERIFIED_PAYMENT",
      metadata: {
        amount_paid: verifiedAmount,
        transaction_namespace: transactionNamespace,
        transaction_reference: transactionReference,
        booking_id: booking.id
      },
      created_at: timestamp
    });

    // 12. Create Outbox / Notification Job for asynchronous delivery
    if (tx.enqueueAutomationJob) {
      await tx.enqueueAutomationJob({
        booking_id: booking.id,
        automation_type: "booking_confirmation",
        event_key: `booking-confirmed:${booking.id}:payment_${payment.id}`,
        scheduled_at: timestamp,
        payload: {
          booking_id: booking.id,
          payment_id: payment.id,
          amount_paid: verifiedAmount,
          currency: payment.currency
        }
      });
    }

    return {
      status: "success",
      payment: updatedPayment,
      booking: updatedBooking,
      allocation: activeAlloc,
      idempotent: false
    };
  });
}

module.exports = {
  PaymentConfirmationError,
  confirmVerifiedPayment
};
