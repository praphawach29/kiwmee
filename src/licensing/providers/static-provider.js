// Salon Booking OS v1 - Static Entitlement Provider
// For single-business production deployment and contract/environment testing

const { PLANS, buildEntitlementsFromPreset } = require("../plans");

const DEFAULT_SINGLE_BUSINESS_ID = "default";

class EntitlementProvider {
  async getEntitlements(businessId) {
    throw new Error("getEntitlements must be implemented by provider");
  }
}

class StaticProvider extends EntitlementProvider {
  constructor(options = {}) {
    super();
    this.env = options.env || process.env;
    this.currentBusinessId = options.currentBusinessId || DEFAULT_SINGLE_BUSINESS_ID;
    this.businessMap = options.businessMap || new Map();
    this.overrides = options.overrides || {};
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
      const configuredPackage = this.env.APP_PACKAGE || PLANS.AI_PRO;
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
