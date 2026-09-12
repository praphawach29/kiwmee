// Salon Booking OS v1 - Transaction Time Validator
// Pure domain validator for ensuring bank transfer timestamps fall within acceptable payment windows.

const { PAYMENT_REASON_CODES } = require("./reason-codes");

const DEFAULT_CLOCK_TOLERANCE_MINUTES = 5; // Accounts for clock skew between bank & salon servers
const DEFAULT_VERIFICATION_GRACE_MINUTES = 10;

const TRANSACTION_TIME_STATUS = {
  VALID: "VALID",
  TOO_EARLY: "TOO_EARLY",
  LATE: "LATE",
  MISSING_TIMESTAMP: "MISSING_TIMESTAMP"
};

/**
 * Validates that a slip's transaction timestamp occurred within an allowable window.
 * 
 * @param {Object} params
 * @param {Object} params.payment - Payment record with created_at and expires_at
 * @param {string|Date} params.transactionAt - Timestamp reported by authoritative provider
 * @param {Object} [params.options] - Configurable tolerance thresholds
 * @returns {{ valid: boolean, status: string, reasonCode: string, description: string }}
 */
function validateTransactionTime({ payment, transactionAt, options = {} }) {
  if (!transactionAt) {
    return {
      valid: false,
      status: TRANSACTION_TIME_STATUS.MISSING_TIMESTAMP,
      reasonCode: PAYMENT_REASON_CODES.MISSING_TRANSACTION_TIME,
      description: "Transaction timestamp is missing from provider response"
    };
  }

  const txnDate = transactionAt instanceof Date ? transactionAt : new Date(transactionAt);
  if (Number.isNaN(txnDate.getTime())) {
    return {
      valid: false,
      status: TRANSACTION_TIME_STATUS.MISSING_TIMESTAMP,
      reasonCode: PAYMENT_REASON_CODES.INVALID_TRANSACTION_TIME,
      description: "Invalid transaction timestamp format"
    };
  }

  const clockToleranceMs = options.clockToleranceSeconds !== undefined
    ? options.clockToleranceSeconds * 1000
    : (options.clockToleranceMinutes ?? DEFAULT_CLOCK_TOLERANCE_MINUTES) * 60 * 1000;

  const graceMs = options.verificationGraceSeconds !== undefined
    ? options.verificationGraceSeconds * 1000
    : (options.verificationGraceMinutes ?? DEFAULT_VERIFICATION_GRACE_MINUTES) * 60 * 1000;

  const createdAt = new Date(payment.created_at || Date.now());
  const expiresAt = new Date(payment.expires_at || (createdAt.getTime() + 15 * 60 * 1000));

  const windowStart = new Date(createdAt.getTime() - clockToleranceMs);
  const windowEnd = new Date(expiresAt.getTime() + graceMs);

  // 1. Transaction occurred before payment intent was created (beyond tolerance)
  if (txnDate < windowStart) {
    return {
      valid: false,
      status: TRANSACTION_TIME_STATUS.TOO_EARLY,
      reasonCode: PAYMENT_REASON_CODES.TRANSACTION_TOO_EARLY,
      description: `Transaction occurred at ${txnDate.toISOString()}, which is earlier than the payment window start (${windowStart.toISOString()})`
    };
  }

  // 2. Transaction occurred after expiration + grace
  if (txnDate > windowEnd) {
    return {
      valid: false,
      status: TRANSACTION_TIME_STATUS.LATE,
      reasonCode: PAYMENT_REASON_CODES.LATE_PAYMENT_REVIEW,
      description: `Transaction occurred at ${txnDate.toISOString()}, which is after the payment deadline (${windowEnd.toISOString()})`
    };
  }

  // 3. Valid within payment window
  return {
    valid: true,
    status: TRANSACTION_TIME_STATUS.VALID,
    reasonCode: PAYMENT_REASON_CODES.SUCCESS,
    description: "Transaction timestamp is within valid payment window"
  };
}

module.exports = {
  TRANSACTION_TIME_STATUS,
  DEFAULT_CLOCK_TOLERANCE_MINUTES,
  validateTransactionTime
};
