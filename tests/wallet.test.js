const test = require("node:test");
const assert = require("node:assert/strict");
const { judgeTopup, reviewTopup, quotaOf, messageAllowed, PLAN_MESSAGES, SKUS, MIN_TOPUP, MAX_TOPUP } = require("../src/v2/wallet");
const { getSetting } = require("../src/v2/platform-settings");

// A slip that EasySlip read, against a top-up the shop asked for.
const read = (over = {}) => ({
  ok: true,
  transRef: "TX123456",
  amount: 1000,
  paidAt: new Date().toISOString(),
  duplicate: false,
  receiver: { name: "บริษัท คิวมี จำกัด", account: "1234567890", proxy: null },
  ...over
});
const BILLING = { promptPay: "0812345678", accountNumber: "1234567890" };

test("a slip for the amount asked, into Kiwmee's account, is credited", () => {
  assert.deepEqual(judgeTopup(read(), { amount: 1000, billing: BILLING }), { status: "passed", reasons: [] });
});

test("paying more than asked is fine — the wallet gets what arrived", () => {
  assert.deepEqual(judgeTopup(read({ amount: 1200 }), { amount: 1000, billing: BILLING }), { status: "passed", reasons: [] });
});

test("short, wrong receiver, reused, too old and in the future are refused with reasons", () => {
  assert.deepEqual(judgeTopup(read({ amount: 500 }), { amount: 1000, billing: BILLING }).reasons, ["AMOUNT_LOW"]);
  assert.deepEqual(judgeTopup(read({ receiver: { account: "9999999999" } }), { amount: 1000, billing: BILLING }).reasons, ["RECEIVER_MISMATCH"]);
  assert.deepEqual(judgeTopup(read({ duplicate: true }), { amount: 1000, billing: BILLING }).reasons, ["DUPLICATE"]);
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  assert.deepEqual(judgeTopup(read({ paidAt: old }), { amount: 1000, billing: BILLING }).reasons, ["TOO_OLD"]);
  const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  assert.deepEqual(judgeTopup(read({ paidAt: future }), { amount: 1000, billing: BILLING }).reasons, ["IN_FUTURE"]);
});

test("an unreadable slip, or a payment above the wallet limit, is not credited", () => {
  assert.deepEqual(judgeTopup(read({ transRef: null, amount: null }), { amount: 1000, billing: BILLING }).reasons, ["UNREADABLE"]);
  assert.deepEqual(judgeTopup(read({ amount: 25000 }), { amount: 1000, billing: BILLING }).reasons, ["AMOUNT_HIGH"]);
});

test("no EasySlip key means no verdict — the slip waits for a human", () => {
  assert.deepEqual(judgeTopup(null, { amount: 1000, billing: BILLING }), { status: "error", reasons: [] });
  assert.deepEqual(judgeTopup({ ok: false, error: "UNAVAILABLE" }, { amount: 1000, billing: BILLING }), { status: "error", reasons: [] });
});

test("the wallet prices match the package table", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SKUS).map(([sku, item]) => [sku, item.amount])),
    { "plan:starter": 390, "plan:pro": 890, "plan:loyalty": 590, "msg:500": 99, "msg:1500": 249, "msg:5000": 699, "slip:100": 59 }
  );
  assert.equal(MIN_TOPUP, 100);
  assert.equal(MAX_TOPUP, 20000);
});

test("the billing account keys are registered settings (the slip check reads them)", async () => {
  const db = { query: async () => ({ rows: [] }) };
  for (const key of ["billing.promptpay", "billing.account_name", "billing.bank"]) {
    assert.equal(await getSetting(db, key, { env: {} }), null, key);
  }
});

test("a review only accepts approve or reject, before touching the database", async () => {
  await assert.rejects(() => reviewTopup("admin-user", "topup-id", "delete"), /คำสั่งไม่ถูกต้อง/);
  await assert.rejects(() => reviewTopup("admin-user", "topup-id", undefined), /คำสั่งไม่ถูกต้อง/);
});


test('the month\'s message quota: allowance by plan, purchases on top, warnings at 80% and 100%', () => {
  assert.equal(PLAN_MESSAGES.pro, 4000);
  assert.deepEqual(quotaOf('pro', { messagesUsed: 2000 }), { used: 2000, total: 4000, remaining: 2000, percent: 50, level: 'ok' });
  assert.equal(quotaOf('pro', { messagesUsed: 3200 }).level, 'warn');
  assert.equal(quotaOf('pro', { messagesUsed: 4000 }).level, 'full');
  assert.deepEqual(quotaOf('starter', { messagesUsed: 300, messagesPurchased: 500 }), { used: 300, total: 1400, remaining: 1100, percent: 21, level: 'ok' });
  // a counter that already knows the allowance wins over the plan default
  assert.equal(quotaOf('starter', { messagesUsed: 100, messagesIncluded: 2000 }).total, 2000);
  // nobody has a zero-length bar
  assert.deepEqual(quotaOf(undefined, {}), { used: 0, total: 0, remaining: 0, percent: 0, level: 'ok' });
});

test("a brand that used up its messages keeps taking bookings but stops sending cards", async () => {
  const { pushLine } = require("../src/v2/line-notify");
  const brandId = "b1000000-0000-4000-8000-000000000001";
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push(sql);
      if (sql.includes("platform_settings")) return { rows: [] };
      if (sql.includes("public.businesses")) {
        return { rows: [{ brand_id: brandId, plan: "free", used: 100, included: 100, purchased: 0 }] };
      }
      return { rows: [] };
    }
  };
  const env = { LINE_CHANNEL_ACCESS_TOKEN: "x".repeat(30) };
  let fetched = 0;
  const result = await pushLine(db, "U" + "0".repeat(32), [{ type: "text", text: "hi" }], {
    env,
    businessId: "a1000000-0000-4000-8000-000000000001",
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true, status: 200 };
    }
  });
  assert.equal(fetched, 0, "no LINE call may be made");
  assert.equal(result.sent, false);
  assert.equal(result.reason, "QUOTA_EXCEEDED");
  assert.equal(result.quota.level, "full");
  assert.equal(calls.some((sql) => sql.includes("usage_add")), false, "a skipped card is not counted");
});

test("with messages left, the card goes out and is counted", async () => {
  const { pushLine } = require("../src/v2/line-notify");
  const brandId = "b1000000-0000-4000-8000-000000000001";
  const counted = [];
  const db = {
    query: async (sql, params) => {
      if (sql.includes("platform_settings")) return { rows: [] };
      if (sql.includes("public.businesses")) {
        return { rows: [{ brand_id: brandId, plan: "pro", used: 10, included: 4000, purchased: 0 }] };
      }
      if (sql.includes("usage_add")) counted.push(params);
      return { rows: [] };
    }
  };
  const result = await pushLine(db, "U" + "0".repeat(32), [{ type: "text", text: "hi" }], {
    env: { LINE_CHANNEL_ACCESS_TOKEN: "x".repeat(30) },
    businessId: "a1000000-0000-4000-8000-000000000001",
    fetchImpl: async () => ({ ok: true, status: 200 })
  });
  assert.equal(result.sent, true);
  assert.equal(counted.length, 1, "one message counted for the brand");
  assert.deepEqual(counted[0], [brandId, 1]);
});

test("the quota level is the only thing that stops sending — warn still sends", () => {
  assert.equal(messageAllowed({ level: "ok" }), true);
  assert.equal(messageAllowed({ level: "warn" }), true);
  assert.equal(messageAllowed({ level: "full" }), false);
  assert.equal(messageAllowed(null), true, "an unread counter must not stop a card");
});
