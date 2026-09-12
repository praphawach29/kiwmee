// Salon Booking OS v1 - Payment & Verification Domain Reason Codes
// Canonical, provider-neutral reason codes for payment operations and slip verification

const PAYMENT_REASON_CODES = {
  // Successful states
  SUCCESS: "SUCCESS",
  EXACT_AMOUNT_MATCH: "EXACT_AMOUNT_MATCH",

  // Slip & Verification mismatch / data issues
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  AMOUNT_MISMATCH_UNDERPAID: "AMOUNT_MISMATCH_UNDERPAID",
  OVERPAYMENT: "OVERPAYMENT",
  OVERPAYMENT_MANUAL_REVIEW: "OVERPAYMENT_MANUAL_REVIEW",
  RECEIVER_MISMATCH: "RECEIVER_MISMATCH",
  INSUFFICIENT_RECEIVER_DATA: "INSUFFICIENT_RECEIVER_DATA",
  DUPLICATE_TRANSACTION: "DUPLICATE_TRANSACTION",
  INVALID_SLIP: "INVALID_SLIP",
  UNREADABLE_SLIP: "UNREADABLE_SLIP",
  TRANSACTION_NOT_FOUND: "TRANSACTION_NOT_FOUND",
  EXPIRED_PAYMENT_INTENT: "EXPIRED_PAYMENT_INTENT",
  NON_AUTHORITATIVE_VERIFICATION: "NON_AUTHORITATIVE_VERIFICATION",

  // Capability & Entitlement issues
  INSUFFICIENT_PROVIDER_CAPABILITY: "INSUFFICIENT_PROVIDER_CAPABILITY",
  ENTITLEMENT_NOT_GRANTED: "ENTITLEMENT_NOT_GRANTED",

  // Timing & Lifecycle issues
  LATE_PAYMENT_REVIEW: "LATE_PAYMENT_REVIEW",
  TRANSACTION_TOO_EARLY: "TRANSACTION_TOO_EARLY",
  MISSING_TRANSACTION_TIME: "MISSING_TRANSACTION_TIME",
  INVALID_TRANSACTION_TIME: "INVALID_TRANSACTION_TIME",
  SLOT_ALREADY_REALLOCATED: "SLOT_ALREADY_REALLOCATED",

  // Provider transport & system issues
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_UNCERTAIN_RESULT: "PROVIDER_UNCERTAIN_RESULT",
  RATE_LIMITED: "RATE_LIMITED",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  UNSUPPORTED_BANK: "UNSUPPORTED_BANK",
  UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR"
};

/**
 * Normalizes vendor-specific error messages or status codes into domain reason codes.
 * Ensures vendor-specific codes never leak into core business logic.
 */
function normalizeVendorReasonCode(vendorCode, vendorMessage = "") {
  if (!vendorCode && !vendorMessage) return PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR;
  const upper = ` ${vendorCode} ${vendorMessage} `.toUpperCase();

  if (upper.includes("SUCCESS") || upper.includes(" 00 ") || upper.trim() === "00" || upper.includes(" OK ") || upper.trim() === "OK" || upper.includes(" 200 ") || upper.trim() === "200") {
    return PAYMENT_REASON_CODES.SUCCESS;
  }
  if (upper.includes("TIMEOUT") || upper.includes("TIMED OUT") || upper.includes("ETIMEDOUT")) {
    return PAYMENT_REASON_CODES.PROVIDER_TIMEOUT;
  }
  if (upper.includes("UNAVAILABLE") || upper.includes("503") || upper.includes("502") || upper.includes("504") || upper.includes("ECONNREFUSED")) {
    return PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE;
  }
  if (upper.includes("RATE_LIMIT") || upper.includes("429") || upper.includes("TOO MANY REQUESTS")) {
    return PAYMENT_REASON_CODES.RATE_LIMITED;
  }
  if (upper.includes("AUTH") || upper.includes("UNAUTHORIZED") || upper.includes("401") || upper.includes("403") || upper.includes("FORBIDDEN") || upper.includes("INVALID_KEY")) {
    return PAYMENT_REASON_CODES.AUTHENTICATION_FAILED;
  }
  if (upper.includes("NOT_FOUND") || upper.includes("TRANSACTION_NOT_FOUND") || upper.includes("SLIP_NOT_FOUND")) {
    return PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND;
  }
  if (upper.includes("DUPLICATE") || upper.includes("ALREADY_USED") || upper.includes("REDEEMED") || upper.includes("SLIP_REUSED")) {
    return PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION;
  }
  if (upper.includes("AMOUNT_MISMATCH") || upper.includes("UNDERPAID") || upper.includes("WRONG_AMOUNT")) {
    return PAYMENT_REASON_CODES.AMOUNT_MISMATCH;
  }
  if (upper.includes("OVERPAID") || upper.includes("OVERPAYMENT") || upper.includes("ERR_OVERPAID")) {
    return PAYMENT_REASON_CODES.OVERPAYMENT;
  }
  if (upper.includes("RECEIVER") || upper.includes("WRONG_ACCOUNT")) {
    return PAYMENT_REASON_CODES.RECEIVER_MISMATCH;
  }
  if (upper.includes("UNSUPPORTED_BANK") || upper.includes("BANK_NOT_SUPPORTED")) {
    return PAYMENT_REASON_CODES.UNSUPPORTED_BANK;
  }
  if (upper.includes("UNREADABLE") || upper.includes("BLURRY") || upper.includes("CORRUPT")) {
    return PAYMENT_REASON_CODES.UNREADABLE_SLIP;
  }
  if (upper.includes("INVALID_SLIP") || upper.includes("NOT_A_SLIP") || upper.includes("BAD_QR")) {
    return PAYMENT_REASON_CODES.INVALID_SLIP;
  }

  return PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR;
}

module.exports = {
  PAYMENT_REASON_CODES,
  normalizeVendorReasonCode
};
