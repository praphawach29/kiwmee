// Salon Booking OS v1 - Payment Domain Module
// Public Façade

const {
  PAYMENT_TYPES,
  SYSTEM_BASELINE_POLICY,
  resolvePolicy,
  calculatePricing
} = require("./pricing-calculator");

const {
  toSatang,
  fromSatang,
  encodeMoneyForDb,
  decodeMoneyFromDb
} = require("./money");

const {
  PAYMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidPaymentTransitionError,
  isValidStatus,
  canTransition,
  validateTransition
} = require("./payment-state-machine");

const {
  FINANCIAL_LOCK_ORDER,
  validateLockAcquisitionOrder
} = require("./lock-order");

const {
  sanitizePayload,
  sanitizePaymentAttempt,
  sanitizeProviderData
} = require("./data-safety");

const {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES,
  createPayment,
  createPendingBookingWithPayment,
  expirePendingPaymentHold,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule
} = require("./payment-service");

const {
  resolvePaymentPolicy,
  resolveCapabilities
} = require("./payment-policy-resolver");

const {
  BookingCheckoutService,
  BookingPaymentOrchestrator,
  checkoutBooking,
  formatPaymentPendingResult
} = require("./booking-checkout-service");

const {
  PaymentConfirmationError,
  confirmVerifiedPayment
} = require("./payment-confirmation-service");

const {
  REFUND_STATUSES,
  calculateRefundBalances,
  decideRefund,
  requestRefund,
  completeRefundMock
} = require("./refund-service");

const { PaymentProvider } = require("./providers/payment-provider");
const { SlipVerificationProvider } = require("./providers/slip-verification-provider");
const { MockPaymentProvider } = require("./providers/mock-payment-provider");
const { MockSlipProvider, MOCK_SLIP_SCENARIOS } = require("./providers/mock-slip-provider");
const {
  AuthoritativeSlipProvider,
  DEFAULT_PROVIDER_CAPABILITIES,
  hasRequiredAutoConfirmCapabilities
} = require("./providers/authoritative-slip-provider");
const {
  SandboxAuthoritativeSlipProvider,
  SANDBOX_SCENARIOS
} = require("./providers/sandbox-authoritative-slip-provider");
const {
  EasySlipV2Provider,
  DEFAULT_EASYSLIP_BASE_URL,
  DEFAULT_EASYSLIP_ENDPOINT,
  EASYSLIP_ERROR_MAPPING,
  normalizeEasySlipErrorCode
} = require("./providers/easyslip-v2-provider");
const {
  SlipProviderTransport,
  SlipTransportError
} = require("./providers/slip-provider-transport");

const {
  PAYMENT_REASON_CODES,
  normalizeVendorReasonCode
} = require("./reason-codes");

const {
  ReceiverMatcher,
  RECEIVER_MATCH_STATUS
} = require("./receiver-matcher");

const {
  validateTransactionTime,
  TRANSACTION_TIME_STATUS
} = require("./transaction-time-validator");

const {
  PaymentPresentationProvider,
  MockPaymentPresentationProvider
} = require("./presentation/payment-presentation");

const {
  SlipIntakeService,
  processSlip,
  processAuthoritativeNotification
} = require("./slip-intake-service");

module.exports = {
  // Pricing & Money
  PAYMENT_TYPES,
  SYSTEM_BASELINE_POLICY,
  toSatang,
  fromSatang,
  encodeMoneyForDb,
  decodeMoneyFromDb,
  resolvePolicy,
  calculatePricing,

  // Policy Resolution (Phase D)
  resolvePaymentPolicy,
  resolveCapabilities,

  // Checkout Orchestration (Phase D)
  BookingCheckoutService,
  BookingPaymentOrchestrator,
  checkoutBooking,
  formatPaymentPendingResult,

  // Lock Ordering
  FINANCIAL_LOCK_ORDER,
  validateLockAcquisitionOrder,

  // Data Safety
  sanitizePayload,
  sanitizePaymentAttempt,
  sanitizeProviderData,

  // State Machine
  PAYMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidPaymentTransitionError,
  isValidStatus,
  canTransition,
  validateTransition,

  // Payment Operations
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  DEFAULT_MANUAL_REVIEW_DEADLINE_MINUTES,
  createPayment,
  createPendingBookingWithPayment,
  expirePendingPaymentHold,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule,

  // Confirmation
  PaymentConfirmationError,
  confirmVerifiedPayment,

  // Refunds
  REFUND_STATUSES,
  calculateRefundBalances,
  decideRefund,
  requestRefund,
  completeRefundMock,

  // Providers & Adapters (Phase E & F)
  PaymentProvider,
  SlipVerificationProvider,
  MockPaymentProvider,
  MockSlipProvider,
  MOCK_SLIP_SCENARIOS,
  AuthoritativeSlipProvider,
  DEFAULT_PROVIDER_CAPABILITIES,
  hasRequiredAutoConfirmCapabilities,
  SandboxAuthoritativeSlipProvider,
  SANDBOX_SCENARIOS,
  EasySlipV2Provider,
  DEFAULT_EASYSLIP_BASE_URL,
  DEFAULT_EASYSLIP_ENDPOINT,
  EASYSLIP_ERROR_MAPPING,
  normalizeEasySlipErrorCode,
  SlipProviderTransport,
  SlipTransportError,

  // Reason Codes & Verification Contracts (Phase F)
  PAYMENT_REASON_CODES,
  normalizeVendorReasonCode,
  ReceiverMatcher,
  RECEIVER_MATCH_STATUS,
  validateTransactionTime,
  TRANSACTION_TIME_STATUS,

  // Payment Presentation & Slip Intake (Phase E & F)
  PaymentPresentationProvider,
  MockPaymentPresentationProvider,
  SlipIntakeService,
  processSlip,
  processAuthoritativeNotification
};

