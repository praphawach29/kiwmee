// Salon Booking OS v1 - Static Entitlement Provider
// For single-business production deployment and contract/environment testing

const { FEATURES } = require("../features");
const { PLANS, buildEntitlementsFromPreset } = require("../plans");

const DEFAULT_SINGLE_BUSINESS_ID = "default";

function parseEnvOverrides(env = process.env) {
  if (!env) return {};
  let overrides = {};
  if (env.FEATURE_OVERRIDES) {
    try {
      const parsed = JSON.parse(env.FEATURE_OVERRIDES);
      if (parsed && typeof parsed === "object") {
        if (parsed.features || parsed.limits) {
          overrides = { ...parsed };
        } else {
          overrides = { features: parsed };
        }
      }
    } catch {
      // ignore
    }
  }

  const featureOverrides = { ...(overrides.features || {}) };

  if (env.PILOT_PAYMENT_ENABLED !== undefined) {
    featureOverrides[FEATURES.payment] = env.PILOT_PAYMENT_ENABLED === "true";
  }
  if (env.PILOT_DEPOSIT_ENABLED !== undefined) {
    featureOverrides[FEATURES.deposit] = env.PILOT_DEPOSIT_ENABLED === "true";
  }
  if (env.PILOT_SLIP_VERIFICATION !== undefined) {
    featureOverrides[FEATURES.slipVerification] = env.PILOT_SLIP_VERIFICATION === "true";
  }
  if (env.PILOT_AUTO_CONFIRM !== undefined || env.AUTO_PAYMENT_CONFIRMATION !== undefined) {
    const val = env.PILOT_AUTO_CONFIRM ?? env.AUTO_PAYMENT_CONFIRMATION;
    featureOverrides[FEATURES.autoPaymentConfirmation] = val === "true";
  }
  if (env.PILOT_REFUND_MANAGEMENT !== undefined || env.REFUND_MANAGEMENT !== undefined) {
    const val = env.PILOT_REFUND_MANAGEMENT ?? env.REFUND_MANAGEMENT;
    featureOverrides[FEATURES.refundManagement] = val === "true";
  }

  return {
    ...overrides,
    features: Object.freeze(featureOverrides)
  };
}

class EntitlementProvider {
  async getEntitlements(businessId) {
    throw new Error("getEntitlements must be implemented by provider");
  }
}

class StaticProvider extends EntitlementProvider {
  constructor(options = {}) {
    super();
    this.defaultPackage = options.defaultPackage || null;
    this.env = options.env || process.env;
    this.currentBusinessId = options.currentBusinessId || DEFAULT_SINGLE_BUSINESS_ID;
    this.businessMap = options.businessMap || new Map();
    const envOverrides = parseEnvOverrides(this.env);
    this.overrides = {
      ...envOverrides,
      ...(options.overrides || {}),
      features: {
        ...(envOverrides.features || {}),
        ...(options.overrides?.features || {})
      },
      limits: {
        ...(envOverrides.limits || {}),
        ...(options.overrides?.limits || {})
      }
    };
  }

  async getEntitlements(businessId) {
    const targetId = businessId || this.currentBusinessId;

    // 1. Check if explicitly configured in custom business map
    if (this.businessMap.has(targetId)) {
      const config = this.businessMap.get(targetId);
      return buildEntitlementsFromPreset(config.plan || PLANS.CUSTOM, config.overrides || {});
    }

    // 2. If it is the current single-business deployment
    if (targetId === this.currentBusinessId) {
      const configuredPackage = this.defaultPackage || this.env.APP_PACKAGE || PLANS.AI_PRO;
      return buildEntitlementsFromPreset(configuredPackage, this.overrides);
    }

    // 3. For any unconfigured/unknown future tenant, fail closed (no free entitlements)
    return {
      features: Object.freeze({}),
      limits: Object.freeze({}),
      metadata: {
        source: "UNENTITLED_TENANT",
        businessId: targetId
      }
    };
  }
}

module.exports = {
  DEFAULT_SINGLE_BUSINESS_ID,
  EntitlementProvider,
  StaticProvider
};
