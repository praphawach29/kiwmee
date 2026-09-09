// Salon Booking OS v1 - Plan Presets & Entitlement Factory
// Presets are used solely to build entitlements. Application layer checks features, never plan names.

const { FEATURES, LIMITS } = require("./features");

const PLANS = Object.freeze({
  BASIC: "BASIC",
  PRO: "PRO",
  AI_PRO: "AI_PRO",
  CUSTOM: "CUSTOM"
});

const PLAN_PRESETS = Object.freeze({
  [PLANS.BASIC]: Object.freeze({
    features: Object.freeze({
      [FEATURES.booking]: true,
      [FEATURES.webBooking]: true,
      [FEATURES.lineBasic]: true,
      [FEATURES.lineFlex]: false,
      [FEATURES.automation]: false,
      [FEATURES.payment]: false,
      [FEATURES.deposit]: false,
      [FEATURES.aiReceptionist]: false,
      [FEATURES.aiFaq]: false,
      [FEATURES.aiRecommendation]: false,
      [FEATURES.humanHandoff]: false,
      [FEATURES.analytics]: false,
      [FEATURES.customBranding]: false,
      [FEATURES.customFlow]: false
    }),
    limits: Object.freeze({
      [LIMITS.maxStaff]: 2,
      [LIMITS.maxServices]: 5,
      [LIMITS.monthlyBookings]: 100,
      [LIMITS.aiMonthlyTurns]: 0,
      [LIMITS.automationMonthlyRuns]: 0
    })
  }),

  [PLANS.PRO]: Object.freeze({
    features: Object.freeze({
      [FEATURES.booking]: true,
      [FEATURES.webBooking]: true,
      [FEATURES.lineBasic]: true,
      [FEATURES.lineFlex]: true,
      [FEATURES.automation]: true,
      [FEATURES.payment]: false,
      [FEATURES.deposit]: false,
      [FEATURES.aiReceptionist]: false,
      [FEATURES.aiFaq]: false,
      [FEATURES.aiRecommendation]: false,
      [FEATURES.humanHandoff]: true,
      [FEATURES.analytics]: true,
      [FEATURES.customBranding]: true,
      [FEATURES.customFlow]: false
    }),
    limits: Object.freeze({
      [LIMITS.maxStaff]: 10,
      [LIMITS.maxServices]: 30,
      [LIMITS.monthlyBookings]: 1000,
      [LIMITS.aiMonthlyTurns]: 0,
      [LIMITS.automationMonthlyRuns]: 5000
    })
  }),

  [PLANS.AI_PRO]: Object.freeze({
    features: Object.freeze({
      [FEATURES.booking]: true,
      [FEATURES.webBooking]: true,
      [FEATURES.lineBasic]: true,
      [FEATURES.lineFlex]: true,
      [FEATURES.automation]: true,
      [FEATURES.payment]: true,
      [FEATURES.deposit]: true,
      [FEATURES.aiReceptionist]: true,
      [FEATURES.aiFaq]: true,
      [FEATURES.aiRecommendation]: true,
      [FEATURES.humanHandoff]: true,
      [FEATURES.analytics]: true,
      [FEATURES.customBranding]: true,
      [FEATURES.customFlow]: true
    }),
    limits: Object.freeze({
      [LIMITS.maxStaff]: 50,
      [LIMITS.maxServices]: 100,
      [LIMITS.monthlyBookings]: 5000,
      [LIMITS.aiMonthlyTurns]: 10000,
      [LIMITS.automationMonthlyRuns]: 20000
    })
  }),

  [PLANS.CUSTOM]: Object.freeze({
    features: Object.freeze({
      [FEATURES.booking]: true,
      [FEATURES.webBooking]: true,
      [FEATURES.lineBasic]: true,
      [FEATURES.lineFlex]: true,
      [FEATURES.automation]: false,
      [FEATURES.payment]: false,
      [FEATURES.deposit]: false,
      [FEATURES.aiReceptionist]: false,
      [FEATURES.aiFaq]: false,
      [FEATURES.aiRecommendation]: false,
      [FEATURES.humanHandoff]: true,
      [FEATURES.analytics]: true,
      [FEATURES.customBranding]: true,
      [FEATURES.customFlow]: true
    }),
    limits: Object.freeze({
      [LIMITS.maxStaff]: 100,
      [LIMITS.maxServices]: 200,
      [LIMITS.monthlyBookings]: 10000,
      [LIMITS.aiMonthlyTurns]: 0,
      [LIMITS.automationMonthlyRuns]: 0
    })
  })
});

function buildEntitlementsFromPreset(planKey = PLANS.AI_PRO, customOverrides = {}) {
  const normalizedKey = String(planKey || PLANS.AI_PRO).toUpperCase();
  const preset = PLAN_PRESETS[normalizedKey] || PLAN_PRESETS[PLANS.AI_PRO];

  const features = { ...preset.features, ...(customOverrides.features || {}) };
  const limits = { ...preset.limits, ...(customOverrides.limits || {}) };

  return {
    features: Object.freeze(features),
    limits: Object.freeze(limits),
    metadata: {
      source: normalizedKey,
      generatedAt: new Date().toISOString()
    }
  };
}

module.exports = {
  PLANS,
  PLAN_PRESETS,
  buildEntitlementsFromPreset
};
