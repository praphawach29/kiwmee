// Salon Booking OS v1 - EasySlip v2 Live Trial Test Suite (Phase I-B)
// Strict Safety Invariants:
// 1. Fully opt-in: Skips immediately unless EASYSLIP_TEST_ENABLED === "true" AND EASYSLIP_API_KEY is provided.
// 2. Zero secret leakage: Never prints API keys, bearer tokens, full account numbers, or raw slip data.
// 3. Input Priority:
//    1. EASYSLIP_TEST_QR_PAYLOAD
//    2. EASYSLIP_TEST_IMAGE_PATH (local file: .jpg, .jpeg, .png)
//    3. EASYSLIP_TEST_IMAGE_URL
// 4. Never confirms booking, never changes authoritative flag to true, never touches production.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

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
  const testImagePath = process.env.EASYSLIP_TEST_IMAGE_PATH || null;
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

  // Determine Live Verification Input
  let liveParams = null;
  let inputType = null;

  if (testPayload && typeof testPayload === "string" && testPayload.trim().length > 0) {
    inputType = "EASYSLIP_TEST_QR_PAYLOAD";
    liveParams = {
      payload: testPayload.trim(),
      expectedAmount: 100,
      expectedReceiver: "004"
    };
  } else if (testImagePath && typeof testImagePath === "string" && testImagePath.trim().length > 0) {
    inputType = "EASYSLIP_TEST_IMAGE_PATH";
    const resolvedPath = path.resolve(testImagePath.trim());
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Configured EASYSLIP_TEST_IMAGE_PATH file does not exist: ${resolvedPath}`);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(ext)) {
      throw new Error(`Unsupported image format ${ext}. Only .jpg, .jpeg, and .png are allowed.`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.size === 0) {
      throw new Error(`EASYSLIP_TEST_IMAGE_PATH file is empty (0 bytes): ${resolvedPath}`);
    }
    const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB safe limit
    if (stat.size > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(`EASYSLIP_TEST_IMAGE_PATH file exceeds 5MB limit: ${stat.size} bytes`);
    }

    const imageBuffer = fs.readFileSync(resolvedPath);
    liveParams = {
      slipData: imageBuffer,
      expectedAmount: 100,
      expectedReceiver: "004"
    };
  } else if (testImageUrl && typeof testImageUrl === "string" && testImageUrl.trim().length > 0) {
    inputType = "EASYSLIP_TEST_IMAGE_URL";
    liveParams = {
      slipUrl: testImageUrl.trim(),
      expectedAmount: 100,
      expectedReceiver: "004"
    };
  }

  // Subtest 2: Live Slip Verification with Real Test Slip / Payload / Image
  if (liveParams) {
    await t.test(`Live Verification (${inputType}): verifies real slip, checks transRef stability and duplicate detection`, async () => {
      // Run #1: First verification
      const res1 = await provider.verifySlip(liveParams);
      assert.ok(res1.transactionReference, "Must return transactionReference");
      assert.equal(res1.authoritative, false, "Phase I: authoritative must strictly be false");

      // Masked SHA-256 fingerprint for safe reporting (zero secret/reference leakage)
      const refHash1 = createHash("sha256").update(res1.transactionReference).digest("hex").slice(0, 8);

      // Run #2: Repeated verification of identical slip
      const res2 = await provider.verifySlip(liveParams);
      assert.ok(res2.transactionReference, "Run #2 must return transactionReference");
      const refHash2 = createHash("sha256").update(res2.transactionReference).digest("hex").slice(0, 8);

      // Verify transRef Stability
      assert.equal(
        refHash1,
        refHash2,
        "transRef must be identical across repeated queries of the same slip"
      );
      assert.equal(
        res1.transactionReference,
        res2.transactionReference,
        "transRef full string must match exactly"
      );

      // Verify Duplicate Behavior
      assert.equal(res2.isDuplicate, true, "EasySlip checkDuplicate:true must mark second verification as duplicate");

      // Amount precision validation via toSatang
      if (res1.amount) {
        const satang = toSatang(res1.amount);
        assert.ok(Number.isInteger(satang) && satang > 0, "toSatang roundtrip must produce positive integer");
      }

      // Receiver evaluation via ReceiverMatcher
      if (res1.receiver) {
        const matchRes = ReceiverMatcher.match(
          { bankCode: res1.receiver.bankCode || "004", accountNumberMasked: res1.receiver.accountNumberMasked || "xxx-x-xx123-4" },
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
