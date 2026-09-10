// Salon Booking OS v1 - Feature & Limit Registry
// 14 Core Capabilities & Quota Limits

const FEATURES = Object.freeze({
  booking: "booking",
  webBooking: "webBooking",
  lineBasic: "lineBasic",
  lineFlex: "lineFlex",
  automation: "automation",
  payment: "payment",
  deposit: "deposit",
  aiReceptionist: "aiReceptionist",
  aiFaq: "aiFaq",
  aiRecommendation: "aiRecommendation",
  humanHandoff: "humanHandoff",
  analytics: "analytics",
  customBranding: "customBranding",
  customFlow: "customFlow",
  slipVerification: "slipVerification",
  autoPaymentConfirmation: "autoPaymentConfirmation",
  paymentGateway: "paymentGateway",
  refundManagement: "refundManagement"
});

const LIMITS = Object.freeze({
  maxStaff: "maxStaff",
  maxServices: "maxServices",
  monthlyBookings: "monthlyBookings",
  aiMonthlyTurns: "aiMonthlyTurns",
  automationMonthlyRuns: "automationMonthlyRuns"
});

function isValidFeature(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(FEATURES, key);
}

function isValidLimit(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(LIMITS, key);
}

module.exports = {
  FEATURES,
  LIMITS,
  isValidFeature,
  isValidLimit
};
