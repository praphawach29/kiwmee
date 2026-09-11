// Salon Booking OS v1 - Payment Policy Resolver
// Resolves active payment policy with strict precedence:
// service override > business default > system baseline (no_payment)
// Capabilities: FEATURES.payment, FEATURES.deposit
// Invariant: Application never checks plan names, only capability flags.
// Fail-Closed Invariant: If a policy requires payment and capability evaluation fails/errors,
// the system MUST NOT downgrade to free booking. It must block checkout with PAYMENT_CAPABILITY_UNAVAILABLE.

const { FEATURES } = require("../licensing/features");
const { hasFeature } = require("../licensing");
const { PAYMENT_TYPES, SYSTEM_BASELINE_POLICY } = require("./pricing-calculator");

/**
 * Resolves whether payment and deposit features are entitled for a business.
 * Throws if the underlying capability check throws.
 */
async function resolveCapabilities({
  businessId = "default",
  entitlements,
  hasFeatureFn
}) {
  let paymentAllowed = false;
  let depositAllowed = false;

  if (typeof hasFeatureFn === "function") {
    paymentAllowed = Boolean(await hasFeatureFn(businessId, FEATURES.payment));
    depositAllowed = Boolean(await hasFeatureFn(businessId, FEATURES.deposit));
  } else if (entitlements) {
    if (typeof entitlements.hasFeature === "function") {
      paymentAllowed = Boolean(await entitlements.hasFeature(businessId, FEATURES.payment));
      depositAllowed = Boolean(await entitlements.hasFeature(businessId, FEATURES.deposit));
    } else if (typeof entitlements === "object") {
      paymentAllowed = Boolean(
        entitlements[FEATURES.payment] ??
        entitlements.payment ??
        false
      );
      depositAllowed = Boolean(
        entitlements[FEATURES.deposit] ??
        entitlements.deposit ??
        false
      );
    }
  } else {
    paymentAllowed = Boolean(await hasFeature(businessId, FEATURES.payment));
    depositAllowed = Boolean(await hasFeature(businessId, FEATURES.deposit));
  }

  return { paymentAllowed, depositAllowed };
}

/**
 * Extracts normalized payment policy object from diverse input formats.
 */
function extractPolicy(source) {
  if (!source || typeof source !== "object") return null;
  if (source.payment_type) return source;
  if (source.paymentPolicy?.payment_type) return source.paymentPolicy;
  if (source.payment_policy?.payment_type) return source.payment_policy;
  if (source.payment?.payment_type) return source.payment;
  return null;
}

/**
 * Central service for resolving the active payment policy with Fail-Closed Guarantees.
 * 
 * Rules:
 * - Precedence: service override > business default > system baseline (no_payment)
 * - If merchant/service requires payment and entitlement check errors/fails:
 *   MUST NOT downgrade to no_payment / free booking!
 *   Throws PAYMENT_CAPABILITY_UNAVAILABLE without leaking internal provider/DB errors.
 * - If merchant/service has no payment policy (baseline no_payment):
 *   Remains safe and allowed even if entitlement provider errors.
 * - If entitlement loaded successfully and payment=false:
 *   Normal package behavior -> force no_payment.
 * - If payment=true and deposit=false:
 *   Supports no_payment or full_payment, forbids deposit modes.
 * - If deposit=true:
 *   Supports deposit_fixed / deposit_percentage.
 * - Application never checks plan names.
 * 
 * @param {Object} params
 * @param {Object} [params.businessSettings] - Business settings or policy
 * @param {Object} [params.serviceSettings] - Service settings or override policy
 * @param {Object|Function} [params.entitlements] - Entitlement map or service
 * @param {Function} [params.hasFeatureFn] - Custom feature check function
 * @param {string} [params.businessId] - Business ID (default: "default")
 * @returns {Promise<Object>} Resolved policy object
 */
async function resolvePaymentPolicy({
  businessSettings,
  serviceSettings,
  entitlements,
  hasFeatureFn,
  businessId = "default"
} = {}) {
  // Precedence 1: Service override
  const servicePolicy = extractPolicy(serviceSettings);
  let candidate = servicePolicy;
  let source = "service_override";

  // Precedence 2: Business default
  if (!candidate) {
    const businessPolicy = extractPolicy(businessSettings);
    candidate = businessPolicy;
    source = "business_default";
  }

  // Precedence 3: System baseline (no_payment)
  // If no policy is configured or merchant explicitly configured no_payment,
  // existing free booking flow is always safe and never blocked by entitlement outages.
  if (!candidate || candidate.payment_type === PAYMENT_TYPES.noPayment) {
    return {
      payment_type: PAYMENT_TYPES.noPayment,
      currency: candidate?.currency || "THB",
      source: candidate ? source : "system_baseline",
      reason: null,
      paymentAllowed: false,
      depositAllowed: false
    };
  }

  // Merchant/Service explicitly requires payment (full_payment, deposit_fixed, deposit_percentage).
  // We MUST verify capabilities with Fail-Closed semantics:
  let capabilities;
  try {
    capabilities = await resolveCapabilities({
      businessId,
      entitlements,
      hasFeatureFn
    });
  } catch (error) {
    // FAIL-CLOSED: Never confirm booking for free if payment was required!
    const err = new Error("Payment capability is temporarily unavailable; checkout cannot proceed");
    err.code = "PAYMENT_CAPABILITY_UNAVAILABLE";
    throw err;
  }

  const { paymentAllowed, depositAllowed } = capabilities;

  // Case A: Entitlement loaded successfully and payment is false
  // Shop does not have payment feature -> force no_payment according to package
  if (!paymentAllowed) {
    return {
      payment_type: PAYMENT_TYPES.noPayment,
      currency: candidate.currency || "THB",
      source: "system_baseline",
      reason: "payment_disabled",
      paymentAllowed: false,
      depositAllowed: false
    };
  }

  const requestedType = candidate.payment_type;

  // Deposit mode validation:
  // Rule: deposit=false -> forbid deposit modes, fallback to no_payment (or explicit deposit_fallback)
  if (
    [PAYMENT_TYPES.depositFixed, PAYMENT_TYPES.depositPercentage].includes(requestedType) &&
    !depositAllowed
  ) {
    return {
      payment_type: candidate.deposit_fallback || PAYMENT_TYPES.noPayment,
      currency: candidate.currency || "THB",
      source: "entitlement_fallback",
      reason: "deposit_feature_disabled",
      paymentAllowed,
      depositAllowed
    };
  }

  // Validate supported type
  if (!Object.values(PAYMENT_TYPES).includes(requestedType)) {
    return {
      payment_type: PAYMENT_TYPES.noPayment,
      currency: candidate.currency || "THB",
      source: "system_baseline",
      reason: `unsupported_type_${requestedType}`,
      paymentAllowed,
      depositAllowed
    };
  }

  return {
    payment_type: requestedType,
    fixed_amount: candidate.fixed_amount ?? candidate.fixedAmount ?? null,
    percentage: candidate.percentage ?? null,
    currency: candidate.currency || "THB",
    source,
    reason: null,
    paymentAllowed,
    depositAllowed
  };
}

module.exports = {
  resolvePaymentPolicy,
  resolveCapabilities
};
