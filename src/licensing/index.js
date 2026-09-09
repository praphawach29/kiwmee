// Salon Booking OS v1 - Licensing & Entitlement Module
// Public Façade

const { FEATURES, LIMITS, isValidFeature, isValidLimit } = require("./features");
const { PLANS, PLAN_PRESETS, buildEntitlementsFromPreset } = require("./plans");
const { FeatureNotEntitledError } = require("./errors");
const { DEFAULT_SINGLE_BUSINESS_ID, EntitlementProvider, StaticProvider } = require("./providers/static-provider");
const { EntitlementService } = require("./entitlement-service");

let defaultService = null;

function getEntitlementService(provider = null, options = {}) {
  if (!defaultService || provider) {
    const activeProvider = provider || new StaticProvider();
    defaultService = new EntitlementService(activeProvider, options);
  }
  return defaultService;
}

function resetEntitlementService() {
  defaultService = null;
}

// Global convenience wrappers bound to default singleton
async function getBusinessEntitlements(businessId) {
  return getEntitlementService().getBusinessEntitlements(businessId);
}

async function hasFeature(businessId, featureKey) {
  return getEntitlementService().hasFeature(businessId, featureKey);
}

async function requireFeature(businessId, featureKey) {
  return getEntitlementService().requireFeature(businessId, featureKey);
}

async function getEntitlement(businessId, featureKey) {
  return getEntitlementService().getEntitlement(businessId, featureKey);
}

async function getLimit(businessId, limitKey) {
  return getEntitlementService().getLimit(businessId, limitKey);
}

function invalidateEntitlementCache(businessId) {
  return getEntitlementService().invalidateEntitlementCache(businessId);
}

module.exports = {
  // Constants & Enums
  FEATURES,
  LIMITS,
  PLANS,
  PLAN_PRESETS,
  DEFAULT_SINGLE_BUSINESS_ID,

  // Validators & Helpers
  isValidFeature,
  isValidLimit,
  buildEntitlementsFromPreset,

  // Errors
  FeatureNotEntitledError,

  // Classes
  EntitlementProvider,
  StaticProvider,
  EntitlementService,

  // Service Management
  getEntitlementService,
  resetEntitlementService,

  // Central API
  getBusinessEntitlements,
  hasFeature,
  requireFeature,
  getEntitlement,
  getLimit,
  invalidateEntitlementCache
};
