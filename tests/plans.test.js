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
    "plan:starter": 390, "plan:starter:year": 3900, "plan:pro": 890, "plan:pro:year": 8900, "plan:loyalty": 590, "plan:loyalty:year": 5900,
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



test("plan refusals read as Thai sentences; other database errors pass through", () => {
  const { planRefusal, PLAN_REASON_TEXT } = require("../src/v2/plans");
  const { AppError } = require("../src/errors");
  const e = planRefusal({ code: "BK422", message: "PLAN_RESOURCES" }, AppError);
  assert.equal(e.status, 422);
  assert.equal(e.details.reason, "PLAN_RESOURCES");
  assert.equal(e.message, PLAN_REASON_TEXT.PLAN_RESOURCES);
  assert.equal(planRefusal({ code: "BK422", message: "FULLY_BOOKED" }, AppError), null);
  assert.equal(planRefusal({ code: "23505", message: "PLAN_RESOURCES" }, AppError), null);
});

const { quotePlan, renewalDecision } = require("../src/v2/plans");
const NOW = new Date("2026-11-08T00:00:00Z");
const iso = (d) => new Date(d).toISOString();

test("quotePlan: new, renew, upgrade with the difference, monthly to yearly with credit, cheaper is scheduled", () => {
  const starter = { effective: "starter", valid_until: "2026-11-20T00:00:00Z", cycle: "month" };
  assert.deepEqual(
    { ...quotePlan({ effective: "free", valid_until: null }, "pro", "month", NOW), validUntil: iso(quotePlan({ effective: "free" }, "pro", "month", NOW).validUntil) },
    { mode: "new", amount: 890, validUntil: "2026-12-08T00:00:00.000Z", cycle: "month" }
  );
  const renew = quotePlan(starter, "starter", "month", NOW);
  assert.deepEqual([renew.mode, renew.amount, iso(renew.validUntil)], ["renew", 390, "2026-12-20T00:00:00.000Z"]);
  const up = quotePlan(starter, "pro", "month", NOW); // 12 of 30 days left: (890 − 390) × 12/30
  assert.deepEqual([up.mode, up.amount, iso(up.validUntil)], ["upgrade", 200, "2026-11-20T00:00:00.000Z"]);
  const year = quotePlan(starter, "starter", "year", NOW); // 3,900 − 390 × 12/30 = 3,744
  assert.deepEqual([year.mode, year.amount, iso(year.validUntil)], ["switch", 3744, "2027-11-08T00:00:00.000Z"]);
  const proYear = quotePlan(starter, "pro", "year", NOW);
  assert.deepEqual([proYear.mode, proYear.amount], ["switch", 8744]);
  assert.equal(quotePlan({ effective: "pro", valid_until: "2026-11-20T00:00:00Z", cycle: "month" }, "starter", "month", NOW).mode, "schedule");
  assert.equal(quotePlan({ effective: "pro", valid_until: "2027-06-01T00:00:00Z", cycle: "year" }, "pro", "month", NOW).mode, "schedule", "a shorter cycle waits");
  // an expired plan is bought fresh
  assert.equal(quotePlan({ effective: "pro", valid_until: "2026-11-01T00:00:00Z", cycle: "month" }, "starter", "month", NOW).mode, "new");
});

test("quotePlan: free days (trial, launch offer) are not paid — the same plan runs on after them, another starts today", () => {
  const gift = { effective: "pro", valid_until: "2027-01-31T16:59:59Z", cycle: "month", complimentary: true };
  const same = quotePlan(gift, "pro", "month", NOW);
  assert.deepEqual([same.mode, same.amount, iso(same.validUntil)], ["after_free", 890, "2027-03-02T16:59:59.000Z"]);
  const other = quotePlan(gift, "starter", "month", NOW);
  assert.deepEqual([other.mode, other.amount, iso(other.validUntil)], ["new", 390, "2026-12-08T00:00:00.000Z"]);
});

test("renewalDecision: 3-day window, scheduled changes, auto-renew off, short wallet, 7 grace days", () => {
  const base = { plan: "pro", cycle: "month", validUntil: "2026-11-10T00:00:00Z", balance: 1000, autoRenew: true };
  assert.equal(renewalDecision({ ...base, validUntil: "2026-11-20T00:00:00Z" }, NOW).action, "none");
  assert.deepEqual(renewalDecision(base, NOW), { action: "renew", amount: 890, plan: "pro", cycle: "month" });
  assert.deepEqual(renewalDecision({ ...base, nextPlan: "starter" }, NOW), { action: "renew", amount: 390, plan: "starter", cycle: "month" });
  assert.deepEqual(renewalDecision({ ...base, nextCycle: "year", balance: 9000 }, NOW), { action: "renew", amount: 8900, plan: "pro", cycle: "year" });
  assert.equal(renewalDecision({ ...base, autoRenew: false }, NOW).action, "end");
  assert.equal(renewalDecision({ ...base, nextPlan: "free" }, NOW).action, "end");
  assert.equal(renewalDecision({ ...base, balance: 100 }, NOW).action, "short");
  const grace = renewalDecision({ ...base, validUntil: "2026-11-07T00:00:00Z", balance: 100 }, NOW);
  assert.deepEqual([grace.action, iso(grace.graceUntil)], ["grace", "2026-11-14T00:00:00.000Z"]);
  assert.equal(renewalDecision({ ...base, validUntil: "2026-11-07T00:00:00Z", graceUntil: "2026-11-14T00:00:00Z", balance: 100 }, NOW).action, "short");
  assert.equal(renewalDecision({ ...base, validUntil: "2026-11-07T00:00:00Z", graceUntil: "2026-11-14T00:00:00Z" }, NOW).action, "renew", "money during grace renews");
  assert.equal(renewalDecision({ ...base, validUntil: "2026-10-01T00:00:00Z", graceUntil: "2026-10-08T00:00:00Z" }, NOW).action, "none", "after grace it is free");
  assert.equal(renewalDecision({ ...base, complimentary: true }, NOW).action, "none");
  assert.equal(renewalDecision({ ...base, plan: "free" }, NOW).action, "none");
});
