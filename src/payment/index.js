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
  sanitizePaymentAttempt
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
  PaymentPresentationProvider,
  MockPaymentPresentationProvider
} = require("./presentation/payment-presentation");

const {
  SlipIntakeService,
  processSlip
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

  // Providers
  PaymentProvider,
  SlipVerificationProvider,
  MockPaymentProvider,
  MockSlipProvider,
  MOCK_SLIP_SCENARIOS,

  // Payment Presentation & Slip Intake (Phase E)
  PaymentPresentationProvider,
  MockPaymentPresentationProvider,
  SlipIntakeService,
  processSlip
};

