// Automatic slip checks (src/v2/slip-check.js): reading EasySlip's answer and judging it — no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { maskedMatches, receiverMatch, readEasySlip, judge } = require("../src/v2/slip-check");

// the shape EasySlip v2 answers with (as v1's adapter reads it)
const answer = ({ amount = 200, transRef = "016307150401BOR01234", date = "2026-11-03T08:10:00+07:00", proxy = "xxx-xxx-5678", account = null, duplicate = false } = {}) => ({
  status: 200,
  data: {
    isDuplicate: duplicate,
    rawSlip: {
      transRef,
      date,
      amount: { amount },
      receiver: { bank: { id: "004" }, account: { name: { th: "นาย บลูม" }, ...(proxy ? { proxy: { type: "MSISDN", account: proxy } } : {}), ...(account ? { bank: { account } } : {}) } }
    }
  }
});

test("masked numbers on slips: every digit shown must sit where the shop's number has it", () => {
  assert.equal(maskedMatches("xxx-xxx-5678", "0812345678"), true);
  assert.equal(maskedMatches("xxx-xxx-5679", "0812345678"), false);
  assert.equal(maskedMatches("xxx-x-x6789-x", "123-4-56789-0"), true);
  assert.equal(maskedMatches("xxx-x-x6788-x", "123-4-56789-0"), false);
  assert.equal(maskedMatches("xxx-xx-x", "1234567"), null, "too little shown to tell");
  assert.equal(maskedMatches("xxxxxxx5678", "0812345678"), true, "a phone written as 66…: the end decides");
});

test("the receiver: PromptPay or account number decide; a name alone does not", () => {
  assert.equal(receiverMatch({ promptPay: "0812345678" }, { proxy: "xxx-xxx-5678" }), "match");
  assert.equal(receiverMatch({ promptPay: "0812345678" }, { proxy: "xxx-xxx-0000" }), "mismatch");
  assert.equal(receiverMatch({ accountNumber: "123-4-56789-0" }, { account: "xxx-x-x6789-x" }), "match");
  assert.equal(receiverMatch({ accountName: "บลูม" }, { name: "บลูม" }), "unknown");
});

test("judging a slip against the booking", () => {
  const booking = { depositDue: 200, bookedAt: "2026-11-03T01:00:00Z", paymentInfo: { promptPay: "0812345678" } };
  assert.deepEqual(judge(readEasySlip(answer(), 200), booking), { status: "passed", reasons: [] });
  assert.deepEqual(judge(readEasySlip(answer({ amount: 199.99 }), 200), booking).reasons, ["AMOUNT_LOW"]);
  assert.deepEqual(judge(readEasySlip(answer({ proxy: "xxx-xxx-1111" }), 200), booking).reasons, ["RECEIVER_MISMATCH"]);
  assert.deepEqual(judge(readEasySlip(answer({ date: "2026-11-02T10:00:00+07:00" }), 200), booking).reasons, ["TOO_EARLY"]);
  assert.deepEqual(judge(readEasySlip(answer({ duplicate: true }), 200), booking).reasons, ["DUPLICATE"]);
  assert.deepEqual(judge(readEasySlip(answer({ transRef: null }), 200), booking).reasons, ["UNREADABLE"]);
  assert.deepEqual(judge(readEasySlip({ status: "error", code: "SLIP_NOT_FOUND" }, 404), booking), { status: "error", reasons: [] });
});
