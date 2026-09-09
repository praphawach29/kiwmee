// Salon Booking OS v1 - Licensing & Entitlement Test Suite
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FEATURES,
  LIMITS,
  PLANS,
  PLAN_PRESETS,
  EntitlementService,
  StaticProvider,
  FeatureNotEntitledError,
  hasFeature,
  requireFeature,
  getBusinessEntitlements,
  getLimit,
  getEntitlement,
  resetEntitlementService,
  DEFAULT_SINGLE_BUSINESS_ID
} = require("../src/licensing");

test("BASIC preset enables core booking and denies premium features", () => {
  const preset = PLAN_PRESETS[PLANS.BASIC];
  assert.equal(preset.features[FEATURES.booking], true);
  assert.equal(preset.features[FEATURES.webBooking], true);
  assert.equal(preset.features[FEATURES.lineBasic], true);
  assert.equal(preset.features[FEATURES.lineFlex], false);
  assert.equal(preset.features[FEATURES.automation], false);
  assert.equal(preset.features[FEATURES.payment], false);
  assert.equal(preset.features[FEATURES.deposit], false);
  assert.equal(preset.features[FEATURES.aiReceptionist], false);
  assert.equal(preset.features[FEATURES.aiFaq], false);
  assert.equal(preset.features[FEATURES.aiRecommendation], false);
  assert.equal(preset.features[FEATURES.humanHandoff], false);
  assert.equal(preset.features[FEATURES.analytics], false);
  assert.equal(preset.features[FEATURES.customBranding], false);
  assert.equal(preset.features[FEATURES.customFlow], false);
});

test("PRO preset enables lineFlex, automation, analytics, customBranding, humanHandoff but denies AI & payment", () => {
  const preset = PLAN_PRESETS[PLANS.PRO];
  assert.equal(preset.features[FEATURES.booking], true);
  assert.equal(preset.features[FEATURES.lineBasic], true);
  assert.equal(preset.features[FEATURES.lineFlex], true);
  assert.equal(preset.features[FEATURES.automation], true);
  assert.equal(preset.features[FEATURES.humanHandoff], true);
  assert.equal(preset.features[FEATURES.analytics], true);
  assert.equal(preset.features[FEATURES.customBranding], true);

  // Denied in PRO
  assert.equal(preset.features[FEATURES.aiReceptionist], false);
  assert.equal(preset.features[FEATURES.aiFaq], false);
  assert.equal(preset.features[FEATURES.payment], false);
  assert.equal(preset.features[FEATURES.deposit], false);
});

test("AI_PRO preset enables all 14 features and sets higher quota limits", () => {
  const preset = PLAN_PRESETS[PLANS.AI_PRO];
  for (const featureKey of Object.values(FEATURES)) {
    assert.equal(preset.features[featureKey], true, `Expected ${featureKey} to be true in AI_PRO`);
  }
  assert.ok(preset.limits[LIMITS.maxStaff] >= 50);
  assert.ok(preset.limits[LIMITS.maxServices] >= 100);
});

test("CUSTOM override allows per-business feature and limit customization", async () => {
  const customMap = new Map();
  customMap.set("biz-salon-vip", {
    plan: PLANS.BASIC,
    overrides: {
      features: {
        [FEATURES.lineFlex]: true, // bought add-on
        [FEATURES.customBranding]: true
      },
      limits: {
        [LIMITS.maxStaff]: 8
      }
    }
  });

  const provider = new StaticProvider({ businessMap: customMap });
  const service = new EntitlementService(provider);

  assert.equal(await service.hasFeature("biz-salon-vip", FEATURES.lineFlex), true);
  assert.equal(await service.hasFeature("biz-salon-vip", FEATURES.customBranding), true);
  assert.equal(await service.hasFeature("biz-salon-vip", FEATURES.automation), false); // still false from BASIC
  assert.equal(await service.getLimit("biz-salon-vip", LIMITS.maxStaff), 8);
});

test("hasFeature returns true for entitled features and false for unentitled", async () => {
  const provider = new StaticProvider({ env: { APP_PACKAGE: "BASIC" } });
  const service = new EntitlementService(provider);

  assert.equal(await service.hasFeature("default", FEATURES.booking), true);
  assert.equal(await service.hasFeature("default", FEATURES.webBooking), true);
  assert.equal(await service.hasFeature("default", FEATURES.lineBasic), true);
  assert.equal(await service.hasFeature("default", FEATURES.lineFlex), false);
  assert.equal(await service.hasFeature("default", FEATURES.automation), false);
  assert.equal(await service.hasFeature("default", FEATURES.aiReceptionist), false);
});

test("requireFeature succeeds when feature is entitled", async () => {
  const provider = new StaticProvider({ env: { APP_PACKAGE: "PRO" } });
  const service = new EntitlementService(provider);

  const allowed = await service.requireFeature("default", FEATURES.lineFlex);
  assert.equal(allowed, true);
});

test("requireFeature throws FeatureNotEntitledError with code FEATURE_NOT_ENTITLED when denied", async () => {
  const provider = new StaticProvider({ env: { APP_PACKAGE: "BASIC" } });
  const service = new EntitlementService(provider);

  await assert.rejects(
    async () => service.requireFeature("default", FEATURES.lineFlex),
    (err) => {
      assert.ok(err instanceof FeatureNotEntitledError);
      assert.equal(err.code, "FEATURE_NOT_ENTITLED");
      assert.equal(err.status, 403);
      assert.match(err.message, /lineFlex/);
      assert.ok(!err.message.includes("BASIC")); // Does not leak plan name
      return true;
    }
  );
});

test("invalid feature key is safely rejected", async () => {
  const provider = new StaticProvider();
  const service = new EntitlementService(provider);

  assert.equal(await service.hasFeature("default", "hackInternalBypass"), false);

  await assert.rejects(
    async () => service.requireFeature("default", "hackInternalBypass"),
    (err) => {
      assert.equal(err.code, "FEATURE_NOT_ENTITLED");
      return true;
    }
  );
});

test("provider error uses Last Known Good Cache when available", async () => {
  let shouldFail = false;
  const mockProvider = {
    async getEntitlements(bizId) {
      if (shouldFail) throw new Error("Database connection lost");
      return {
        features: { [FEATURES.booking]: true, [FEATURES.automation]: true },
        limits: { [LIMITS.maxStaff]: 10 }
      };
    }
  };

  const service = new EntitlementService(mockProvider, { ttlMs: 1 }); // immediate expire to test LKGC

  // 1. Initial success populate cache and LKGC
  const first = await service.getBusinessEntitlements("biz-1");
  assert.equal(first.features[FEATURES.automation], true);

  // Wait 2ms for TTL to expire
  await new Promise((r) => setTimeout(r, 5));

  // 2. Provider fails: service should recover via Last Known Good Cache
  shouldFail = true;
  const recovered = await service.getBusinessEntitlements("biz-1");
  assert.equal(recovered.features[FEATURES.automation], true);
  assert.equal(recovered.limits[LIMITS.maxStaff], 10);
});

test("provider error uses safe deployment fallback when no cache exists", async () => {
  const failingProvider = {
    async getEntitlements() {
      throw new Error("Fatal DB outage");
    }
  };

  const service = new EntitlementService(failingProvider, { currentBusinessId: "default" });

  const fallback = await service.getBusinessEntitlements("default");
  assert.equal(fallback.features[FEATURES.booking], true);
  assert.equal(fallback.features[FEATURES.webBooking], true);
  assert.equal(fallback.features[FEATURES.lineBasic], true);
  assert.equal(fallback.metadata.source, "SAFE_DEPLOYMENT_FALLBACK");
});

test("premium features fail closed upon provider outage with safe fallback", async () => {
  const failingProvider = {
    async getEntitlements() {
      throw new Error("Remote service down");
    }
  };

  const service = new EntitlementService(failingProvider);

  // Premium features MUST be false
  assert.equal(await service.hasFeature("default", FEATURES.lineFlex), false);
  assert.equal(await service.hasFeature("default", FEATURES.automation), false);
  assert.equal(await service.hasFeature("default", FEATURES.aiReceptionist), false);
  assert.equal(await service.hasFeature("default", FEATURES.payment), false);
  assert.equal(await service.hasFeature("default", FEATURES.deposit), false);

  // Unknown foreign tenants fail completely closed without even basic booking
  assert.equal(await service.hasFeature("future-unknown-tenant", FEATURES.booking), false);
});

test("getLimit returns quota number for valid limits and null for invalid", async () => {
  const provider = new StaticProvider({ env: { APP_PACKAGE: "PRO" } });
  const service = new EntitlementService(provider);

  assert.equal(await service.getLimit("default", LIMITS.maxStaff), 10);
  assert.equal(await service.getLimit("default", LIMITS.maxServices), 30);
  assert.equal(await service.getLimit("default", "unknownLimit"), null);
});

test("invalidateEntitlementCache clears cached values", async () => {
  let calls = 0;
  const countingProvider = {
    async getEntitlements() {
      calls++;
      return { features: { [FEATURES.booking]: true }, limits: {} };
    }
  };

  const service = new EntitlementService(countingProvider, { ttlMs: 60000 });
  await service.getBusinessEntitlements("biz-a");
  await service.getBusinessEntitlements("biz-a");
  assert.equal(calls, 1); // Cached

  service.invalidateEntitlementCache("biz-a");
  await service.getBusinessEntitlements("biz-a");
  assert.equal(calls, 2); // Re-fetched
});

test("StaticProvider defaults to AI_PRO for current single-business deployment when env is empty", async () => {
  resetEntitlementService();
  const provider = new StaticProvider({ env: {} }); // no APP_PACKAGE
  const entitlements = await provider.getEntitlements(DEFAULT_SINGLE_BUSINESS_ID);

  assert.equal(entitlements.features[FEATURES.booking], true);
  assert.equal(entitlements.features[FEATURES.lineFlex], true);
  assert.equal(entitlements.features[FEATURES.aiReceptionist], true);
  assert.equal(entitlements.features[FEATURES.automation], true);
});

test("Global convenience wrappers work seamlessly", async () => {
  resetEntitlementService();
  const res = await getBusinessEntitlements();
  assert.ok(res.features);
  assert.equal(await hasFeature(null, FEATURES.booking), true);
  assert.equal(await requireFeature(null, FEATURES.booking), true);

  const detail = await getEntitlement(null, FEATURES.booking);
  assert.equal(detail.enabled, true);

  const limitVal = await getLimit(null, LIMITS.maxStaff);
  assert.ok(typeof limitVal === "number");
});
