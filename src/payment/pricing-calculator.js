// Salon Booking OS v1 - Payment Pricing Calculator
// Deterministic financial calculation using integer satang (1 THB = 100 Satang)

const PAYMENT_TYPES = {
  noPayment: "no_payment",
  depositFixed: "deposit_fixed",
  depositPercentage: "deposit_percentage",
  fullPayment: "full_payment"
};

const SYSTEM_BASELINE_POLICY = Object.freeze({
  payment_type: PAYMENT_TYPES.noPayment
});

/**
 * Converts a Baht value (numeric or string) into integer Satang.
 * Guards against floating point inaccuracies.
 */
function toSatang(amountInBaht) {
  const num = Number(amountInBaht);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid monetary amount: ${amountInBaht}`);
  }
  return Math.round(num * 100);
}

/**
 * Converts integer Satang back to standard Baht float with 2 decimal precision.
 */
function fromSatang(satang) {
  return Number((satang / 100).toFixed(2));
}

/**
 * Resolves the active payment policy following precedence:
 * service-level override > business-level default > system baseline (no_payment)
 */
function resolvePolicy({ servicePolicy, businessPolicy }) {
  if (servicePolicy && servicePolicy.payment_type) {
    return servicePolicy;
  }
  if (businessPolicy && businessPolicy.payment_type) {
    return businessPolicy;
  }
  return SYSTEM_BASELINE_POLICY;
}

/**
 * Calculates the payment amount due based on service price and active policy.
 * 
 * @param {Object} params
 * @param {number|string} params.servicePrice - Base price of the service in THB
 * @param {Object} [params.servicePolicy] - Optional service-level policy override
 * @param {Object} [params.businessPolicy] - Optional business-level default policy
 * @returns {Object} Calculated pricing summary
 */
function calculatePricing({ servicePrice, servicePolicy, businessPolicy }) {
  const priceSatang = toSatang(servicePrice);
  const policy = resolvePolicy({ servicePolicy, businessPolicy });

  let amountDueSatang = 0;
  const paymentType = policy.payment_type;

  switch (paymentType) {
    case PAYMENT_TYPES.noPayment:
      amountDueSatang = 0;
      break;

    case PAYMENT_TYPES.depositFixed: {
      const fixedSatang = toSatang(policy.fixed_amount ?? policy.fixedAmount ?? 0);
      // Fixed deposit cannot exceed total service price
      amountDueSatang = Math.min(fixedSatang, priceSatang);
      break;
    }

    case PAYMENT_TYPES.depositPercentage: {
      const percentage = Number(policy.percentage ?? 0);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        throw new Error(`Invalid deposit percentage: ${percentage}`);
      }
      // Standard financial half-up rounding in integer satang
      amountDueSatang = Math.round(priceSatang * (percentage / 100));
      break;
    }

    case PAYMENT_TYPES.fullPayment:
      amountDueSatang = priceSatang;
      break;

    default:
      throw new Error(`Unsupported payment policy type: ${paymentType}`);
  }

  const amountDue = fromSatang(amountDueSatang);
  const remainingDue = fromSatang(Math.max(0, priceSatang - amountDueSatang));

  return {
    servicePrice: fromSatang(priceSatang),
    amountDue,
    remainingDue,
    paymentType,
    currency: policy.currency || "THB",
    policySource: servicePolicy?.payment_type ? "service" : (businessPolicy?.payment_type ? "business" : "baseline")
  };
}

module.exports = {
  PAYMENT_TYPES,
  SYSTEM_BASELINE_POLICY,
  toSatang,
  fromSatang,
  resolvePolicy,
  calculatePricing
};
