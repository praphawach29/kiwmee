const test = require("node:test");
const assert = require("node:assert/strict");
const { brandAction, setBrandPlan, adjustWallet, endOf } = require("../src/v2/platform-plans");

const BRAND = "b1000000-0000-4000-8000-0000000000aa";
const USER = "e1000000-0000-4000-8000-0000000000aa";

test("inputs are checked before anything touches the database", async () => {
  await assert.rejects(brandAction(USER, { action: "nope", brandId: BRAND }), (e) => e.status === 400);
  await assert.rejects(setBrandPlan(USER, "not-a-uuid", { plan: "pro", reason: "ทดสอบ" }), (e) => e.status === 400);
  await assert.rejects(setBrandPlan(USER, BRAND, { plan: "gold", reason: "ทดสอบ" }), (e) => e.status === 422);
  await assert.rejects(setBrandPlan(USER, BRAND, { plan: "pro", reason: "x" }), (e) => /เหตุผล/.test(e.message));
  await assert.rejects(setBrandPlan(USER, BRAND, { plan: "pro", validUntil: "2020-01-01", reason: "ทดสอบ" }), (e) => /อนาคต/.test(e.message));
  await assert.rejects(adjustWallet(USER, BRAND, { amount: 0, reason: "ทดสอบ" }), (e) => e.status === 422);
  await assert.rejects(adjustWallet(USER, BRAND, { amount: 200000, reason: "ทดสอบ" }), (e) => e.status === 422);
  await assert.rejects(adjustWallet(USER, BRAND, { amount: 1.234, reason: "ทดสอบ" }), (e) => e.status === 422);
});

test("an end date is the end of that day in Bangkok; empty = no end", () => {
  assert.equal(endOf("2027-01-31").toISOString(), "2027-01-31T16:59:59.000Z");
  assert.equal(endOf(""), null);
  assert.equal(endOf(null), null);
  assert.throws(() => endOf("31/01/2027"), /ไม่ถูกต้อง/);
});

test("the /super route loads and refuses anonymous requests", async () => {
  const { POST } = require("../app/api/super/brands/route");
  const res = await POST(new Request("http://x/api/super/brands", { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
});
