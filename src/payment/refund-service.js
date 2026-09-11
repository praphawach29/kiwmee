// Salon Booking OS v1 - Refund Decision & Foundation Service
// Strict separation between Refund Decision/Calculation and Refund Execution

const { randomUUID } = require("node:crypto");
const { toSatang, fromSatang } = require("./pricing-calculator");

const REFUND_STATUSES = {
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
};

/**
 * Calculates refund totals and available refundable balance.
 * Uses integer satang arithmetic to prevent floating-point drift.
 */
function calculateRefundBalances(payment, refunds = []) {
  const amountPaidSatang = toSatang(payment.amount_paid || 0);

  let completedSatang = 0;
  let inFlightSatang = 0;

  for (const refund of refunds) {
    if (refund.status === REFUND_STATUSES.completed) {
      completedSatang += toSatang(refund.amount);
    } else if ([REFUND_STATUSES.pending, REFUND_STATUSES.processing].includes(refund.status)) {
      inFlightSatang += toSatang(refund.amount);
    }
  }

  const refundableSatang = Math.max(0, amountPaidSatang - completedSatang - inFlightSatang);

  return {
    amountPaid: fromSatang(amountPaidSatang),
    completedRefundTotal: fromSatang(completedSatang),
    inFlightRefundTotal: fromSatang(inFlightSatang),
    refundableBalance: fromSatang(refundableSatang)
  };
}

/**
 * Validates whether a requested refund amount is permissible.
 * Invariant: completedRefundTotal + inFlightRefundTotal + requestedAmount <= amountPaid
 */
function decideRefund({ payment, refunds = [], requestedAmount }) {
  const reqSatang = toSatang(requestedAmount);
  if (reqSatang <= 0) {
    return {
      approved: false,
      reason: "REFUND_AMOUNT_MUST_BE_POSITIVE",
      requestedAmount: fromSatang(reqSatang)
    };
  }

  const balances = calculateRefundBalances(payment, refunds);
  const maxAllowedSatang = toSatang(balances.refundableBalance);

  if (reqSatang > maxAllowedSatang) {
    return {
      approved: false,
      reason: "EXCEEDS_REFUNDABLE_BALANCE",
      requestedAmount: fromSatang(reqSatang),
      refundableBalance: balances.refundableBalance,
      maxAllowed: balances.refundableBalance
    };
  }

  return {
    approved: true,
    balances,
    requestedAmount: fromSatang(reqSatang),
    remainingBalanceAfterRefund: fromSatang(maxAllowedSatang - reqSatang)
  };
}

/**
 * Records a refund request in the database ledger inside an atomic transaction.
 * Does NOT execute funds movement directly.
 */
async function requestRefund(repository, {
  paymentId,
  bookingId,
  amount,
  reason,
  idempotencyKey,
  approvedBy = "admin",
  provider = "manual_or_mock",
  now = new Date()
}) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return repository.transaction(async (tx) => {
    // 1. Check refund idempotency
    if (tx.findRefundByIdempotencyKey) {
      const existing = await tx.findRefundByIdempotencyKey(idempotencyKey);
      if (existing) {
        return { refund: existing, idempotent: true };
      }
    }

    // 2. Lock/load payment
    const payment = await tx.getPaymentForUpdate(paymentId);
    if (!payment) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // 3. Load all existing refunds for payment to verify invariant
    const existingRefunds = (await tx.getRefundsForPayment?.(paymentId)) || [];

    const decision = decideRefund({ payment, refunds: existingRefunds, requestedAmount: amount });
    if (!decision.approved) {
      const err = new Error(`Refund rejected: ${decision.reason}`);
      err.code = decision.reason;
      err.details = decision;
      throw err;
    }

    // 4. Insert refund record (pending)
    const refundRecord = {
      id: randomUUID(),
      payment_id: paymentId,
      booking_id: bookingId || payment.original_booking_id,
      amount: decision.requestedAmount,
      reason,
      status: REFUND_STATUSES.pending,
      idempotency_key: idempotencyKey,
      provider,
      provider_refund_id: null,
      approved_by: approvedBy,
      completed_at: null,
      created_at: timestamp,
      updated_at: timestamp
    };

    const insertedRefund = await tx.insertRefund(refundRecord);

    // 5. Append-only audit event
    await tx.insertPaymentEvent({
      id: randomUUID(),
      payment_id: paymentId,
      event_type: "refund_requested",
      from_status: payment.status,
      to_status: payment.status,
      actor: approvedBy,
      reason_code: "REFUND_REQUESTED",
      metadata: {
        refund_id: insertedRefund.id,
        amount: decision.requestedAmount,
        reason,
        idempotency_key: idempotencyKey
      },
      created_at: timestamp
    });

    return {
      refund: insertedRefund,
      decision,
      idempotent: false
    };
  });
}

/**
 * Mock execution interface: marks a pending refund as completed
 * Simulates future payment gateway callback/execution without live external calls.
 */
async function completeRefundMock(repository, { refundId, providerRefundId, actor = "system", now = new Date() }) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  return repository.transaction(async (tx) => {
    const refund = await tx.getRefundForUpdate?.(refundId);
    if (!refund) {
      throw new Error(`Refund ${refundId} not found`);
    }
    if (refund.status === REFUND_STATUSES.completed) {
      return { refund, idempotent: true };
    }

    const updated = await tx.updateRefund(refundId, {
      status: REFUND_STATUSES.completed,
      provider_refund_id: providerRefundId || `mock_ref_${Date.now()}`,
      completed_at: timestamp,
      updated_at: timestamp
    });

    // Record allocation release if applicable
    if (tx.insertPaymentAllocation) {
      await tx.insertPaymentAllocation({
        id: randomUUID(),
        payment_id: refund.payment_id,
        booking_id: refund.booking_id,
        amount: refund.amount,
        allocation_type: "refund_release",
        status: "refunded",
        created_at: timestamp,
        released_at: timestamp,
        metadata: { refund_id: refund.id }
      });
    }

    // Append-only audit event
    await tx.insertPaymentEvent({
      id: randomUUID(),
      payment_id: refund.payment_id,
      event_type: "refund_completed",
      from_status: refund.status,
      to_status: REFUND_STATUSES.completed,
      actor,
      reason_code: "REFUND_COMPLETED",
      metadata: { refund_id: refund.id, amount: refund.amount },
      created_at: timestamp
    });

    return { refund: updated, idempotent: false };
  });
}

module.exports = {
  REFUND_STATUSES,
  calculateRefundBalances,
  decideRefund,
  requestRefund,
  completeRefundMock
};
