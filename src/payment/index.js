// Salon Booking OS v1 - Payment Domain Module
// Public Façade

const {
  PAYMENT_TYPES,
  SYSTEM_BASELINE_POLICY,
  toSatang,
  fromSatang,
  resolvePolicy,
  calculatePricing
} = require("./pricing-calculator");

const {
  PAYMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidPaymentTransitionError,
  isValidStatus,
  canTransition,
  validateTransition
} = require("./payment-state-machine");

const {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  DEFAULT_VERIFICATION_GRACE_MINUTES,
  createPayment,
  evaluateSlipVerification,
  evaluateVerificationGrace,
  transferAllocationForReschedule
} = require("./payment-service");

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

module.exports = {
  // Pricing
  PAYMENT_TYPES,
  SYSTEM_BASELINE_POLICY,
  toSatang,
  fromSatang,
  resolvePolicy,
  calculatePricing,

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
  createPayment,
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
  MOCK_SLIP_SCENARIOS
};
