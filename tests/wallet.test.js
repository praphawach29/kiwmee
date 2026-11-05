const test = require("node:test");
const assert = require("node:assert/strict");
const { judgeTopup, reviewTopup, SKUS, MIN_TOPUP, MAX_TOPUP } = require("../src/v2/wallet");
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

