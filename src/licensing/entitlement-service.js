// Salon Booking OS v1 - Entitlement Service
// Central capability-based access control engine with TTL cache and Last-Known-Good fail-safe

const { isValidFeature, isValidLimit } = require("./features");
const { FeatureNotEntitledError } = require("./errors");
const { DEFAULT_SINGLE_BUSINESS_ID } = require("./providers/static-provider");
const { logEvent } = require("../observability/logger");

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class EntitlementService {
  constructor(provider, options = {}) {
    this.provider = provider;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.currentBusinessId = options.currentBusinessId || DEFAULT_SINGLE_BUSINESS_ID;

    // In-memory cache: Map<businessId, { entitlements, expiresAt }>
    this.cache = new Map();

    // Last Known Good Cache (LKGC): Map<businessId, entitlements>
    this.lastKnownGoodCache = new Map();

    // Configured Safe Deployment Fallback for current deployment
    this.safeDeploymentFallback = options.safeDeploymentFallback || Object.freeze({
      features: Object.freeze({
        booking: true,
        webBooking: true,
        lineBasic: true,
        lineFlex: false,
        automation: false,
        payment: false,
        deposit: false,
        aiReceptionist: false,
        aiFaq: false,
        aiRecommendation: false,
        humanHandoff: false,
        analytics: false,
        customBranding: false,
        customFlow: false,
        slipVerification: false,
        autoPaymentConfirmation: false,
        paymentGateway: false,
        refundManagement: false
      }),
      limits: Object.freeze({
        maxStaff: 2,
        maxServices: 5,
        monthlyBookings: 50,
        aiMonthlyTurns: 0,
        automationMonthlyRuns: 0
      }),
      metadata: {
        source: "SAFE_DEPLOYMENT_FALLBACK",
        isFallback: true
      }
    });
  }

  /**
   * Retrieve full entitlements for a business
   */
  async getBusinessEntitlements(businessId = this.currentBusinessId) {
    const targetId = businessId || this.currentBusinessId;
    const now = Date.now();

    // 1. Check TTL Cache
    const cached = this.cache.get(targetId);
    if (cached && cached.expiresAt > now) {
      return cached.entitlements;
    }

    // 2. Fetch from Provider
    try {
      const entitlements = await this.provider.getEntitlements(targetId);

      // Save to TTL cache & LKGC
      this.cache.set(targetId, {
        entitlements,
        expiresAt: now + this.ttlMs
      });
      this.lastKnownGoodCache.set(targetId, entitlements);

      return entitlements;
    } catch (error) {
      logEvent("licensing_provider_error", {
        business_id: targetId,
        error: error.message
      }, console.error);

      // 3. Fail-safe step A: Check Last Known Good Cache (LKGC)
      if (this.lastKnownGoodCache.has(targetId)) {
        return this.lastKnownGoodCache.get(targetId);
      }

      // 4. Fail-safe step B: Safe Deployment Fallback ONLY for current deployment
      if (targetId === this.currentBusinessId) {
        return this.safeDeploymentFallback;
      }

      // 5. For unknown/other tenants, fail completely closed
      return Object.freeze({
        features: Object.freeze({}),
        limits: Object.freeze({}),
        metadata: {
          source: "FAILED_CLOSED",
          error: "Provider unreachable and no cache available"
        }
      });
    }
  }

  /**
   * Check if a feature is enabled
   */
  async hasFeature(businessId = this.currentBusinessId, featureKey) {
    if (!isValidFeature(featureKey)) return false;
    const entitlements = await this.getBusinessEntitlements(businessId);
    return Boolean(entitlements.features?.[featureKey]);
  }

  /**
   * Require feature or throw FeatureNotEntitledError
   */
  async requireFeature(businessId = this.currentBusinessId, featureKey) {
    if (!isValidFeature(featureKey)) {
      throw new FeatureNotEntitledError(featureKey);
    }
    const enabled = await this.hasFeature(businessId, featureKey);
    if (!enabled) {
      throw new FeatureNotEntitledError(featureKey);
    }
    return true;
  }

  /**
   * Get specific entitlement detail
   */
  async getEntitlement(businessId = this.currentBusinessId, featureKey) {
    if (!isValidFeature(featureKey)) {
      return { feature: featureKey, enabled: false };
    }
    const entitlements = await this.getBusinessEntitlements(businessId);
    return {
      feature: featureKey,
      enabled: Boolean(entitlements.features?.[featureKey]),
      metadata: entitlements.metadata || null
    };
  }

  /**
   * Get quota limit value
   */
  async getLimit(businessId = this.currentBusinessId, limitKey) {
    if (!isValidLimit(limitKey)) return null;
    const entitlements = await this.getBusinessEntitlements(businessId);
    return entitlements.limits?.[limitKey] ?? null;
  }

  /**
   * Invalidate cache for a specific business or all businesses
   */
  invalidateEntitlementCache(businessId = null) {
    if (businessId) {
      this.cache.delete(businessId);
    } else {
      this.cache.clear();
    }
  }
}

module.exports = { EntitlementService };
