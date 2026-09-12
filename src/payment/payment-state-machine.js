// Salon Booking OS v1 - Payment State Machine
// Governs valid lifecycle transitions for payments

const PAYMENT_STATUSES = {
  pending: "pending",
  slipReceived: "slip_received",
  verifying: "verifying",
  paid: "paid",
  manualReview: "manual_review",
  verificationFailed: "verification_failed",
  expired: "expired"
};

const ALLOWED_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUSES.pending]: Object.freeze([
    PAYMENT_STATUSES.slipReceived,
    PAYMENT_STATUSES.verifying,
    PAYMENT_STATUSES.paid,
    PAYMENT_STATUSES.manualReview,
    PAYMENT_STATUSES.expired
  ]),
  [PAYMENT_STATUSES.slipReceived]: Object.freeze([
    PAYMENT_STATUSES.verifying,
    PAYMENT_STATUSES.manualReview,
    PAYMENT_STATUSES.verificationFailed,
    PAYMENT_STATUSES.expired
  ]),
  [PAYMENT_STATUSES.verifying]: Object.freeze([
    PAYMENT_STATUSES.paid,
    PAYMENT_STATUSES.manualReview,
    PAYMENT_STATUSES.verificationFailed
  ]),
  [PAYMENT_STATUSES.manualReview]: Object.freeze([
    PAYMENT_STATUSES.paid,
    PAYMENT_STATUSES.verificationFailed,
    PAYMENT_STATUSES.expired
  ]),
  [PAYMENT_STATUSES.verificationFailed]: Object.freeze([
    PAYMENT_STATUSES.slipReceived,
    PAYMENT_STATUSES.expired
  ]),
  [PAYMENT_STATUSES.paid]: Object.freeze([]), // Terminal financial state. Refunds are tracked via separate refunds ledger.
  [PAYMENT_STATUSES.expired]: Object.freeze([]) // Terminal state.
});

class InvalidPaymentTransitionError extends Error {
  constructor(fromStatus, toStatus, reason) {
    super(`Cannot transition payment from '${fromStatus}' to '${toStatus}'${reason ? `: ${reason}` : ""}`);
    this.name = "InvalidPaymentTransitionError";
    this.code = "INVALID_PAYMENT_TRANSITION";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

function isValidStatus(status) {
  return Object.values(PAYMENT_STATUSES).includes(status);
}

function canTransition(fromStatus, toStatus) {
  if (!isValidStatus(fromStatus) || !isValidStatus(toStatus)) {
    return false;
  }
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

function validateTransition(fromStatus, toStatus, reason = null) {
  if (!isValidStatus(fromStatus)) {
    throw new InvalidPaymentTransitionError(fromStatus, toStatus, `Source status '${fromStatus}' is not a recognized payment status`);
  }
  if (!isValidStatus(toStatus)) {
    throw new InvalidPaymentTransitionError(fromStatus, toStatus, `Target status '${toStatus}' is not a recognized payment status`);
  }
  if (!canTransition(fromStatus, toStatus)) {
    throw new InvalidPaymentTransitionError(fromStatus, toStatus, reason);
  }
  return true;
}

module.exports = {
  PAYMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidPaymentTransitionError,
  isValidStatus,
  canTransition,
  validateTransition
};
