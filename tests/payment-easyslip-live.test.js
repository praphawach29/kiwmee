// Salon Booking OS v1 - EasySlip v2 Live Trial Test Suite (Phase I)
// Strict Safety Invariants:
// 1. Fully opt-in: Skips immediately unless EASYSLIP_TEST_ENABLED === "true" AND EASYSLIP_API_KEY is provided.
// 2. Zero secret leakage: Never prints API keys, bearer tokens, full account numbers, or raw slip data.
// 3. Never confirms booking, never changes authoritative flag to true, never touches production.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EasySlipV2Provider,
  PAYMENT_REASON_CODES,
  ReceiverMatcher,
  RECEIVER_MATCH_STATUS,
  validateTransactionTime,
  TRANSACTION_TIME_STATUS,
  toSatang,
  sanitizePayload
} = require("../src/payment");

const shouldRunLive = process.env.EASYSLIP_TEST_ENABLED === "true" && Boolean(process.env.EASYSLIP_API_KEY);

test("EasySlip v2 Live Trial Suite (Opt-in)", { skip: !shouldRunLive }, async (t) => {
  const apiKey = process.env.EASYSLIP_API_KEY;
  const testPayload = process.env.EASYSLIP_TEST_QR_PAYLOAD || null;
  const testImageUrl = process.env.EASYSLIP_TEST_IMAGE_URL || null;

  const provider = new EasySlipV2Provider({
    apiKey,
    authoritativeConfirmed: false // Strict Phase I invariant: defaults to false
  });

  // Subtest 1: Live Error Handling (Safe non-financial error)
  await t.test("Live Error Mapping: malformed payload returns normalized error without leaking secret", async () => {
    await assert.rejects(
      async () => provider.verifySlip({ payload: "MALFORMED_PROMPTPAY_PAYLOAD_STRING", expectedAmount: 100, expectedReceiver: "004" }),
      (err) => {
        assert.ok(err.code, "Must have normalized error code");
        assert.ok(!err.message.includes(apiKey), "Must not leak API key in error message");
        return true;
      }
    );
  });

  // Subtest 2: Live Slip Verification with Real Test Slip
  if (testPayload || testImageUrl) {
    await t.test("Live Verification: parses test slip, verifies transRef stability and duplicate behavior", async () => {
      const verifyParams = {
        payload: testPayload,
        slipUrl: testImageUrl,
        expectedAmount: 100,
        expectedReceiver: "004"
      };

      // Run #1: First verification
      const res1 = await provider.verifySlip(verifyParams);
      assert.ok(res1.transactionReference, "Must return transactionReference");
      assert.equal(res1.authoritative, false, "Phase I: authoritative must strictly be false");

      // Run #2: Repeated verification of same slip
      const res2 = await provider.verifySlip(verifyParams);
      assert.equal(
        res1.transactionReference,
        res2.transactionReference,
        "transRef must be stable across repeated queries of the same slip"
      );

      // Verify Duplicate Behavior
      assert.equal(res2.isDuplicate, true, "EasySlip checkDuplicate:true must mark second verification as duplicate");

      // Amount precision validation via toSatang
      if (res1.amount) {
        const satang = toSatang(res1.amount);
        assert.ok(Number.isInteger(satang) && satang > 0, "toSatang roundtrip must produce positive integer");
      }

      // Receiver evaluation
      if (res1.receiver) {
        const matchRes = ReceiverMatcher.match(
          { bankCode: "004", accountNumberMasked: "xxx-x-xx123-4" },
          res1.receiver
        );
        assert.ok([RECEIVER_MATCH_STATUS.MATCH, RECEIVER_MATCH_STATUS.MISMATCH, RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA].includes(matchRes.status));
      }

      // Transaction time evaluation
      if (res1.transactionAt) {
        const parsed = new Date(res1.transactionAt);
        assert.ok(!Number.isNaN(parsed.getTime()), "transactionAt must parse as valid ISO date");
      }
    });
  }
});
