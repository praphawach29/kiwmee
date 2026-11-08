const test = require("node:test");
const assert = require("node:assert/strict");
const { PLANS, ADDONS, LIMIT_ROWS, FEATURE_ROWS, buildSkus, planCatalog, planById, PLAN_PRICES, PLAN_MESSAGES } = require("../src/v2/plans");
const wallet = require("../src/v2/wallet");
const revenue = require("../src/v2/platform-revenue");

test("one plan table: prices, messages and SKUs all come from src/v2/plans.js", () => {
  assert.deepEqual(PLANS.map((p) => p.id), ["free", "starter", "pro", "loyalty"]);
  assert.deepEqual(PLAN_PRICES, { free: 0, starter: 390, pro: 890, loyalty: 590 });
  assert.deepEqual(PLAN_MESSAGES, { free: 100, starter: 900, pro: 4000, loyalty: 1200 });
  // the wallet and the revenue report read the same numbers
  assert.equal(wallet.PLAN_PRICES, PLAN_PRICES);
  assert.equal(wallet.PLAN_MESSAGES, PLAN_MESSAGES);
  assert.equal(revenue.PLAN_PRICES, PLAN_PRICES);
  assert.deepEqual(wallet.SKUS, buildSkus());
});

test("SKUs keep the prices shops already pay (no plan sold for free)", () => {
  const skus = buildSkus();
  assert.deepEqual(Object.fromEntries(Object.entries(skus).map(([k, v]) => [k, v.amount])), {
    "plan:starter": 390, "plan:pro": 890, "plan:loyalty": 590,
    "msg:500": 99, "msg:1500": 249, "msg:5000": 699, "slip:100": 59
  });
  assert.equal(skus["plan:free"], undefined);
  assert.equal(skus["plan:pro"].apply, "plan");
  assert.equal(skus["msg:1500"].count, 1500);
});

test("every plan states every limit and feature the comparison table shows", () => {
  for (const plan of PLANS) {
    for (const row of LIMIT_ROWS) assert.ok(row.key in plan.limits, `${plan.id} lacks ${row.key}`);
    for (const row of FEATURE_ROWS) assert.equal(typeof plan.features[row.key], "boolean", `${plan.id}.${row.key}`);
    assert.ok(plan.yearly === 0 || plan.yearly === plan.monthly * 10, `${plan.id}: a year costs ten months`);
  }
  assert.equal(PLANS.filter((p) => p.recommended).map((p) => p.id).join(), "pro");
  assert.equal(planById("nope").id, "free");
  assert.ok(ADDONS.every((a) => a.amount > 0 && a.sku.includes(":")));
});

test("the catalog sent to the browser is plain data and does not share objects with the table", () => {
  const catalog = planCatalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
  catalog.plans[0].limits.messages = 1;
  assert.equal(PLANS[0].limits.messages, 100);
});

test("buying a cheaper plan mid-cycle is refused so paid days are never lost; renewing or upgrading is fine", () => {
  const { downgradeLosesDays } = require("../src/v2/wallet");
  const now = new Date("2026-11-08T00:00:00Z");
  const pro = { effective: "pro", valid_until: "2026-11-30T00:00:00Z" };
  assert.equal(downgradeLosesDays(pro, "starter", now), true);
  assert.equal(downgradeLosesDays(pro, "loyalty", now), true);
  assert.equal(downgradeLosesDays(pro, "pro", now), false);
  assert.equal(downgradeLosesDays({ effective: "starter", valid_until: "2026-11-30T00:00:00Z" }, "pro", now), false);
  assert.equal(downgradeLosesDays({ effective: "pro", valid_until: "2026-11-01T00:00:00Z" }, "starter", now), false, "an expired plan can be replaced");
  assert.equal(downgradeLosesDays({ effective: "free", valid_until: null }, "starter", now), false);
});
