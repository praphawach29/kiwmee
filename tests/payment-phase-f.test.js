// Salon Booking OS v1 - Payment Phase F Test Suite
// Covers:
// 1. Provider-Neutral Contract & Normalized Reason Codes
// 2. Provider Capability Model & Gate Checks
// 3. Receiver Matching Model (Strong identifiers vs secondary display name)
// 4. Pure Domain Transaction Time Validation (Window, Tolerance, Grace, Late)
// 5. HTTP Transport Abstraction & Bounded Retry Policy
// 6. Data Safety & Redaction of Sensitive Provider Metadata
// 7. Deterministic Sandbox Authoritative Slip Provider Scenarios (11+ Scenarios)
// 8. Authoritative Confirmation Gate (12 Invariants)
// 9. Late Payment Safety & Conflict Containment (Booking B untouched, Booking A routed to manual review)

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  PAYMENT_STATUSES,
  PAYMENT_REASON_CODES,
  normalizeVendorReasonCode,
  ReceiverMatcher,
  RECEIVER_MATCH_STATUS,
  validateTransactionTime,
  TRANSACTION_TIME_STATUS,
  DEFAULT_PROVIDER_CAPABILITIES,
  hasRequiredAutoConfirmCapabilities,
  SlipProviderTransport,
  SlipTransportError,
  AuthoritativeSlipProvider,
  SandboxAuthoritativeSlipProvider,
  SANDBOX_SCENARIOS,
  sanitizeProviderData,
  evaluateSlipVerification,
  SlipIntakeService,
  processSlip,
  processAuthoritativeNotification
} = require("../src/payment");

const { FakeRepository, buildSeed } = require("./fake-repository");

// Helper: generate dummy base64 slip image
const DUMMY_SLIP_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Mock Content Provider for processSlip tests
class MockContentProvider {
  constructor(buffer = DUMMY_SLIP_IMAGE) {
    this.buffer = buffer;
  }
  async getImageContent() {
    return {
      buffer: this.buffer,
      contentType: "image/png",
      contentLength: this.buffer.length
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Provider-Neutral Contract & Normalized Reason Codes
// ---------------------------------------------------------------------------

test("Phase F: Normalized reason codes map vendor codes to domain standard", () => {
  assert.equal(normalizeVendorReasonCode("00"), PAYMENT_REASON_CODES.SUCCESS);
  assert.equal(normalizeVendorReasonCode("SUCCESS"), PAYMENT_REASON_CODES.SUCCESS);
  assert.equal(normalizeVendorReasonCode("WRONG_AMOUNT"), PAYMENT_REASON_CODES.AMOUNT_MISMATCH);
  assert.equal(normalizeVendorReasonCode("ERR_OVERPAID"), PAYMENT_REASON_CODES.OVERPAYMENT);
  assert.equal(normalizeVendorReasonCode("RECEIVER_NOT_MATCH"), PAYMENT_REASON_CODES.RECEIVER_MISMATCH);
  assert.equal(normalizeVendorReasonCode("SLIP_REUSED"), PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION);
  assert.equal(normalizeVendorReasonCode("NOT_FOUND"), PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND);
  assert.equal(normalizeVendorReasonCode("ETIMEDOUT"), PAYMENT_REASON_CODES.PROVIDER_TIMEOUT);
  assert.equal(normalizeVendorReasonCode("429"), PAYMENT_REASON_CODES.RATE_LIMITED);
  assert.equal(normalizeVendorReasonCode("401"), PAYMENT_REASON_CODES.AUTHENTICATION_FAILED);
  assert.equal(normalizeVendorReasonCode("503"), PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(normalizeVendorReasonCode("RANDOM_UNKNOWN_ERROR_XYZ"), PAYMENT_REASON_CODES.UNKNOWN_PROVIDER_ERROR);
});

test("Phase F: Normalized verification result contract supports all required fields", () => {
  const provider = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.VALID_AUTHORITATIVE });
  const res = provider.generateScenarioResult(SANDBOX_SCENARIOS.VALID_AUTHORITATIVE, {
    expectedAmount: 350,
    expectedReceiver: "0812345678"
  });

  assert.equal(typeof res.verified, "boolean");
  assert.equal(typeof res.authoritative, "boolean");
  assert.equal(typeof res.provider, "string");
  assert.ok(res.providerRequestId);
  assert.equal(res.transactionNamespace, "promptpay_qr");
  assert.ok(res.transactionReference);
  assert.equal(res.amountSatang, 35000);
  assert.equal(res.currency, "THB");
  assert.ok(res.receiver);
  assert.ok(res.sender);
  assert.ok(res.transactionAt);
  assert.equal(res.reasonCode, PAYMENT_REASON_CODES.SUCCESS);
  assert.equal(res.rawStatus, "COMPLETED");
});

// ---------------------------------------------------------------------------
// 2. Provider Capability Model
// ---------------------------------------------------------------------------

test("Phase F: Capability model requires transaction ref, amount, receiver, and transaction time for auto-confirmation", () => {
  assert.equal(hasRequiredAutoConfirmCapabilities(DEFAULT_PROVIDER_CAPABILITIES), true);

  // Missing transaction reference
  assert.equal(hasRequiredAutoConfirmCapabilities({
    ...DEFAULT_PROVIDER_CAPABILITIES,
    supportsTransactionReference: false
  }), false);

  // Missing amount verification
  assert.equal(hasRequiredAutoConfirmCapabilities({
    ...DEFAULT_PROVIDER_CAPABILITIES,
    supportsAmountVerification: false
  }), false);

  // Missing receiver verification
  assert.equal(hasRequiredAutoConfirmCapabilities({
    ...DEFAULT_PROVIDER_CAPABILITIES,
    supportsReceiverVerification: false
  }), false);

  // Missing transaction time capability (NEW Hardening invariant)
  assert.equal(hasRequiredAutoConfirmCapabilities({
    ...DEFAULT_PROVIDER_CAPABILITIES,
    supportsTransactionTime: false
  }), false);
});

// ---------------------------------------------------------------------------
// 3. Receiver Matching Model (ReceiverMatcher)
// ---------------------------------------------------------------------------

test("Phase F: ReceiverMatcher matches strong identifiers (PromptPay, MerchantId, Bank+Account)", () => {
  // 1. PromptPay strong match
  const match1 = ReceiverMatcher.match("0812345678", { promptPayIdentifierMasked: "081-xxx-5678" });
  assert.equal(match1.status, RECEIVER_MATCH_STATUS.MATCH);

  // 2. Merchant ID strong match
  const match2 = ReceiverMatcher.match(
    { merchantIdentifier: "MID_99999" },
    { merchantIdentifier: "MID_99999" }
  );
  assert.equal(match2.status, RECEIVER_MATCH_STATUS.MATCH);

  // 3. Bank code + Account number strong match
  const match3 = ReceiverMatcher.match(
    { bankCode: "004", accountNumberMasked: "xxx-x-12345-x" },
    { bankCode: "004", accountNumberMasked: "xxx-x-12345-x" }
  );
  assert.equal(match3.status, RECEIVER_MATCH_STATUS.MATCH);
});

test("Phase F: ReceiverMatcher rejects strong identifier mismatch", () => {
  // Different PromptPay identifiers
  const mismatch1 = ReceiverMatcher.match("0812345678", { promptPayIdentifierMasked: "089-xxx-9999" });
  assert.equal(mismatch1.status, RECEIVER_MATCH_STATUS.MISMATCH);

  // Different bank code
  const mismatch2 = ReceiverMatcher.match(
    { bankCode: "004", accountNumberMasked: "xxx-1234" },
    { bankCode: "014", accountNumberMasked: "xxx-1234" }
  );
  assert.equal(mismatch2.status, RECEIVER_MATCH_STATUS.MISMATCH);
});

test("Phase F: ReceiverMatcher returns INSUFFICIENT_DATA on account name alone (NEVER auto-confirm on name)", () => {
  const result = ReceiverMatcher.match(
    { accountName: "GLAMOUR SALON BKK" },
    { accountName: "GLAMOUR SALON BKK" }
  );
  assert.equal(result.status, RECEIVER_MATCH_STATUS.INSUFFICIENT_DATA);
  assert.ok(result.reason.includes("Account name match is secondary signal only"));
});

// ---------------------------------------------------------------------------
// 4. Pure Domain Transaction Time Validation
// ---------------------------------------------------------------------------

test("Phase F: validateTransactionTime validates payment creation, expiry, and acceptable tolerance", () => {
  const payment = {
    created_at: "2026-09-15T10:00:00.000Z",
    expires_at: "2026-09-15T10:15:00.000Z"
  };

  // 1. Transaction within window -> VALID
  const res1 = validateTransactionTime({
    payment,
    transactionAt: "2026-09-15T10:05:00.000Z"
  });
  assert.equal(res1.valid, true);
  assert.equal(res1.status, TRANSACTION_TIME_STATUS.VALID);

  // 2. Transaction within clock tolerance (2 minutes before payment created) -> VALID
  const res2 = validateTransactionTime({
    payment,
    transactionAt: "2026-09-15T09:59:00.000Z",
    options: { clockToleranceSeconds: 120 }
  });
  assert.equal(res2.valid, true);
  assert.equal(res2.status, TRANSACTION_TIME_STATUS.VALID);

  // 3. Transaction too early (10 minutes before payment created) -> TOO_EARLY
  const res3 = validateTransactionTime({
    payment,
    transactionAt: "2026-09-15T09:50:00.000Z"
  });
  assert.equal(res3.valid, false);
  assert.equal(res3.status, TRANSACTION_TIME_STATUS.TOO_EARLY);
  assert.equal(res3.reasonCode, PAYMENT_REASON_CODES.TRANSACTION_TOO_EARLY);

  // 4. Transaction late (after expires_at + grace) -> LATE
  const res4 = validateTransactionTime({
    payment,
    transactionAt: "2026-09-15T10:20:00.000Z",
    options: { verificationGraceSeconds: 60 }
  });
  assert.equal(res4.valid, false);
  assert.equal(res4.status, TRANSACTION_TIME_STATUS.LATE);
  assert.equal(res4.reasonCode, PAYMENT_REASON_CODES.LATE_PAYMENT_REVIEW);
});

// ---------------------------------------------------------------------------
// 5. HTTP Transport Abstraction & Bounded Retry
// ---------------------------------------------------------------------------

test("Phase F: SlipProviderTransport enforces safe retry and request idempotency policy", async () => {
  // 1. Idempotent POST (supportsRequestIdempotency + requestId) on 503 -> retries and succeeds
  let idempotentCalls = 0;
  const mock503ThenSuccess = async () => {
    idempotentCalls++;
    if (idempotentCalls < 3) {
      return {
        status: 503,
        ok: false,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: "Service Unavailable" })
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ verified: true })
    };
  };

  const idempTransport = new SlipProviderTransport({
    maxRetries: 2,
    baseBackoffMs: 10,
    supportsRequestIdempotency: true,
    fetchFn: mock503ThenSuccess
  });

  const idempRes = await idempTransport.post("https://api.test/verify", { slip: "test" }, {
    requestId: "req_123"
  });
  assert.equal(idempRes.status, 200);
  assert.equal(idempotentCalls, 3, "Idempotent POST must retry up to configured max");

  // 2. Non-idempotent POST on 503 -> NO blind retry, halts on attempt 1 with PROVIDER_UNCERTAIN_RESULT
  let nonIdempCalls = 0;
  const mock503Fetch = async () => {
    nonIdempCalls++;
    return {
      status: 503,
      ok: false,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "Service Unavailable" })
    };
  };

  const nonIdempTransport = new SlipProviderTransport({
    maxRetries: 3,
    baseBackoffMs: 10,
    supportsRequestIdempotency: false, // Provider does NOT guarantee idempotency
    fetchFn: mock503Fetch
  });

  await assert.rejects(
    () => nonIdempTransport.post("https://api.test/verify", { slip: "test" }, { requestId: "req_xyz" }),
    (err) => {
      assert.equal(err.code, PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(nonIdempCalls, 1, "Non-idempotent POST must NEVER blind retry 503");

  // 3. Timeout after send without request idempotency -> PROVIDER_UNCERTAIN_RESULT
  let timeoutCalls = 0;
  const mockTimeoutFetch = async () => {
    timeoutCalls++;
    const err = new Error("The operation was aborted due to timeout");
    err.name = "AbortError";
    throw err;
  };

  const timeoutTransport = new SlipProviderTransport({
    maxRetries: 2,
    baseBackoffMs: 10,
    supportsRequestIdempotency: false,
    fetchFn: mockTimeoutFetch
  });

  await assert.rejects(
    () => timeoutTransport.post("https://api.test/verify", { slip: "test" }),
    (err) => {
      assert.equal(err.code, PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(timeoutCalls, 1, "Timeout on non-idempotent POST must not retry");

  // 4. Non-retryable 401 Unauthorized -> halts immediately
  let authCalls = 0;
  const mock401Fetch = async () => {
    authCalls++;
    return {
      status: 401,
      ok: false,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "Unauthorized" })
    };
  };
  const authTransport = new SlipProviderTransport({
    maxRetries: 3,
    supportsRequestIdempotency: true,
    fetchFn: mock401Fetch
  });
  await assert.rejects(
    () => authTransport.post("https://api.test/verify", { slip: "test" }, { requestId: "req_auth" }),
    (err) => {
      assert.equal(err.code, PAYMENT_REASON_CODES.AUTHENTICATION_FAILED);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(authCalls, 1, "401 must NEVER be retried");

  // 5. 429 with Retry-After header + idempotency -> bounded retry
  let rateLimitCalls = 0;
  const mock429Fetch = async () => {
    rateLimitCalls++;
    if (rateLimitCalls === 1) {
      return {
        status: 429,
        ok: false,
        headers: {
          get: (name) => name.toLowerCase() === "retry-after" ? "1" : "application/json"
        },
        text: async () => JSON.stringify({ error: "Rate limit" })
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ verified: true })
    };
  };
  const rateLimitTransport = new SlipProviderTransport({
    maxRetries: 2,
    baseBackoffMs: 10,
    supportsRequestIdempotency: true,
    fetchFn: mock429Fetch
  });
  const rateRes = await rateLimitTransport.post("https://api.test/verify", {}, { requestId: "req_rl" });
  assert.equal(rateRes.status, 200);
  assert.equal(rateLimitCalls, 2);

  // 6. Max retries count is strictly bounded (never exceeds configured max)
  let alwaysFailCalls = 0;
  const mockAlways503 = async () => {
    alwaysFailCalls++;
    return {
      status: 503,
      ok: false,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "Down" })
    };
  };
  const boundedTransport = new SlipProviderTransport({
    maxRetries: 2,
    baseBackoffMs: 10,
    supportsRequestIdempotency: true,
    fetchFn: mockAlways503
  });
  await assert.rejects(
    () => boundedTransport.post("https://api.test/verify", {}, { requestId: "req_bounded" })
  );
  assert.equal(alwaysFailCalls, 3, "1 initial + 2 retries = exactly 3 attempts, never exceeds max");
});

// ---------------------------------------------------------------------------
// 6. Data Safety & Redaction
// ---------------------------------------------------------------------------

test("Phase F: sanitizeProviderData redacts secrets, bearer tokens, account numbers, and ID numbers", () => {
  const sensitiveRaw = {
    apiKey: "live_sec_1234567890",
    authorization: "Bearer secret_jwt_token_here",
    nested: {
      accountNumber: "1234567890",
      citizenId: "1234567890123",
      safeDescription: "PromptPay verification result"
    }
  };

  const sanitized = sanitizeProviderData(sensitiveRaw);
  assert.equal(sanitized.apiKey, "[REDACTED]");
  assert.equal(sanitized.authorization, "[REDACTED]");
  assert.ok(sanitized.nested.accountNumber.includes("789"));
  assert.ok(sanitized.nested.citizenId.includes("0123"));
  assert.equal(sanitized.nested.safeDescription, "PromptPay verification result");
});

// ---------------------------------------------------------------------------
// 7. Deterministic Sandbox Authoritative Slip Provider Scenarios (All 11)
// ---------------------------------------------------------------------------

test("Phase F: SandboxAuthoritativeSlipProvider handles all 11 deterministic scenarios", async () => {
  const params = { expectedAmount: 250, expectedReceiver: "0812345678" };

  // 1. VALID_AUTHORITATIVE
  const pValid = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.VALID_AUTHORITATIVE });
  const rValid = await pValid.verifySlip(params);
  assert.equal(rValid.verified, true);
  assert.equal(rValid.authoritative, true);
  assert.equal(rValid.amountSatang, 25000);

  // 2. NON_AUTHORITATIVE_OCR
  const pOcr = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.NON_AUTHORITATIVE_OCR });
  const rOcr = await pOcr.verifySlip(params);
  assert.equal(rOcr.verified, true);
  assert.equal(rOcr.authoritative, false); // OCR is NEVER authoritative

  // 3. UNDERPAYMENT
  const pUnder = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.UNDERPAYMENT });
  const rUnder = await pUnder.verifySlip(params);
  assert.equal(rUnder.amountSatang < 25000, true);
  assert.equal(rUnder.reasonCode, PAYMENT_REASON_CODES.AMOUNT_MISMATCH);

  // 4. OVERPAYMENT
  const pOver = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.OVERPAYMENT });
  const rOver = await pOver.verifySlip(params);
  assert.equal(rOver.amountSatang > 25000, true);
  assert.equal(rOver.reasonCode, PAYMENT_REASON_CODES.OVERPAYMENT);

  // 5. WRONG_RECEIVER
  const pWrongRec = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.WRONG_RECEIVER });
  const rWrongRec = await pWrongRec.verifySlip(params);
  assert.equal(rWrongRec.reasonCode, PAYMENT_REASON_CODES.RECEIVER_MISMATCH);

  // 6. DUPLICATE_TRANSACTION
  const pDup = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.DUPLICATE_TRANSACTION });
  const rDup = await pDup.verifySlip(params);
  assert.equal(rDup.reasonCode, PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION);

  // 7. LATE_PAYMENT
  const pLate = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.LATE_PAYMENT });
  const rLate = await pLate.verifySlip(params);
  assert.equal(rLate.reasonCode, PAYMENT_REASON_CODES.LATE_PAYMENT_REVIEW);

  // 8. TRANSACTION_NOT_FOUND
  const pNotFound = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.TRANSACTION_NOT_FOUND });
  const rNotFound = await pNotFound.verifySlip(params);
  assert.equal(rNotFound.verified, false);
  assert.equal(rNotFound.reasonCode, PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND);

  // 9. TIMEOUT (Throws provider error)
  const pTimeout = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.TIMEOUT });
  await assert.rejects(
    () => pTimeout.verifySlip(params),
    (err) => err.code === PAYMENT_REASON_CODES.PROVIDER_TIMEOUT
  );

  // 10. RATE_LIMIT (Throws provider error)
  const pRate = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.RATE_LIMIT });
  await assert.rejects(
    () => pRate.verifySlip(params),
    (err) => err.code === PAYMENT_REASON_CODES.RATE_LIMITED
  );

  // 11. PROVIDER_DOWN (Throws provider error)
  const pDown = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.PROVIDER_DOWN });
  await assert.rejects(
    () => pDown.verifySlip(params),
    (err) => err.code === PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE
  );

  // 12. AUTH_FAILURE (Throws provider error)
  const pAuth = new SandboxAuthoritativeSlipProvider({ scenario: SANDBOX_SCENARIOS.AUTH_FAILURE });
  await assert.rejects(
    () => pAuth.verifySlip(params),
    (err) => err.code === PAYMENT_REASON_CODES.AUTHENTICATION_FAILED
  );
});

// ---------------------------------------------------------------------------
// 8. Authoritative Confirmation Gate (12 Invariants)
// ---------------------------------------------------------------------------

test("Phase F: evaluateSlipVerification requires authoritative=true, complete capabilities, and valid transaction time", () => {
  const payment = { amount_due: 300, business_id: "biz_1" };

  // Case A: Verified = true, but Authoritative = false (e.g. AI/OCR)
  const ocrResult = {
    verified: true,
    authoritative: false,
    amountSatang: 30000,
    receiver: { merchantIdentifier: "biz_1" },
    transactionReference: "TXN_OCR_12345",
    transactionAt: new Date().toISOString()
  };

  const evalOcr = evaluateSlipVerification({ payment, verificationResult: ocrResult });
  assert.equal(evalOcr.eligibleForAutoConfirmation, false);
  assert.equal(evalOcr.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evalOcr.reasonCode, PAYMENT_REASON_CODES.NON_AUTHORITATIVE_VERIFICATION);

  // Case B: Verified = true AND Authoritative = true -> SUCCESS
  const authResult = {
    ...ocrResult,
    authoritative: true
  };
  const evalAuth = evaluateSlipVerification({ payment, verificationResult: authResult });
  assert.equal(evalAuth.eligibleForAutoConfirmation, true);
  assert.equal(evalAuth.recommendedStatus, PAYMENT_STATUSES.paid);
  assert.equal(evalAuth.reasonCode, PAYMENT_REASON_CODES.EXACT_AMOUNT_MATCH);

  // Case C: Missing provider transaction time capability -> INSUFFICIENT_PROVIDER_CAPABILITY
  const evalNoTimeCap = evaluateSlipVerification({
    payment,
    verificationResult: authResult,
    options: {
      capabilities: {
        ...DEFAULT_PROVIDER_CAPABILITIES,
        supportsTransactionTime: false
      }
    }
  });
  assert.equal(evalNoTimeCap.eligibleForAutoConfirmation, false);
  assert.equal(evalNoTimeCap.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evalNoTimeCap.reasonCode, PAYMENT_REASON_CODES.INSUFFICIENT_PROVIDER_CAPABILITY);

  // Case D: Authoritative result missing transactionAt -> MISSING_TRANSACTION_TIME
  const noTimeResult = {
    verified: true,
    authoritative: true,
    amountSatang: 30000,
    receiver: { merchantIdentifier: "biz_1" },
    transactionReference: "TXN_NOTIME"
    // transactionAt omitted
  };
  const evalNoTime = evaluateSlipVerification({ payment, verificationResult: noTimeResult });
  assert.equal(evalNoTime.eligibleForAutoConfirmation, false);
  assert.equal(evalNoTime.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evalNoTime.reasonCode, PAYMENT_REASON_CODES.MISSING_TRANSACTION_TIME);

  // Case E: Malformed transactionAt timestamp -> INVALID_TRANSACTION_TIME
  const malformedTimeResult = {
    ...authResult,
    transactionAt: "invalid-date-format-xyz"
  };
  const evalMalformedTime = evaluateSlipVerification({ payment, verificationResult: malformedTimeResult });
  assert.equal(evalMalformedTime.eligibleForAutoConfirmation, false);
  assert.equal(evalMalformedTime.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evalMalformedTime.reasonCode, PAYMENT_REASON_CODES.INVALID_TRANSACTION_TIME);
});

// ---------------------------------------------------------------------------
// 9. Late Payment Safety & Conflict Containment (Booking B untouched)
// ---------------------------------------------------------------------------

test("Phase F: Late payment on expired/re-allocated slot routes to LATE_PAYMENT_MANUAL_REVIEW, preserves evidence, and leaves Booking B untouched", async () => {
  const repo = new FakeRepository(buildSeed());
  const staff = repo.staff[0];
  const service = repo.services[0];
  const customerA = await repo.insertCustomer({
    name: "Customer Alpha",
    phone: "0811111111"
  });

  const slotStart = "2026-09-20T10:00:00+07:00";
  const slotEnd = "2026-09-20T10:45:00+07:00";

  // 1. Booking A is created and later expires
  const bookingA = await repo.insertBooking({
    customer_id: customerA.id,
    service_id: service.id,
    staff_id: staff.id,
    start_at: slotStart,
    end_at: slotEnd,
    status: "expired" // expired after timeout
  });

  const paymentA = await repo.insertPayment({
    original_booking_id: bookingA.id,
    business_id: "biz_1",
    amount_due: 350,
    status: PAYMENT_STATUSES.pending,
    expires_at: new Date(Date.now() - 3600 * 1000).toISOString() // expired 1 hour ago
  });

  // 2. Booking B claims the exact same slot
  const customerB = await repo.insertCustomer({
    name: "Customer Beta",
    phone: "0899999999"
  });

  const bookingB = await repo.insertBooking({
    customer_id: customerB.id,
    service_id: service.id,
    staff_id: staff.id,
    start_at: slotStart,
    end_at: slotEnd,
    status: "confirmed" // Confirmed active booking
  });

  // Verify initial setup: Booking B owns the slot
  const conflictBefore = await repo.findConflictingActiveBooking(staff.id, slotStart, slotEnd, bookingA.id);
  assert.equal(conflictBefore.id, bookingB.id);

  // 3. Authoritative provider reports late payment for Booking A
  const lateAuthResult = {
    verified: true,
    authoritative: true,
    provider: "authoritative_provider",
    providerRequestId: "req_auth_late_999",
    transactionNamespace: "promptpay_qr",
    transactionReference: "TXN_LATE_GENUINE_001",
    amountSatang: 35000,
    receiver: { merchantIdentifier: "biz_1" },
    transactionAt: new Date(Date.now() - 3000 * 1000).toISOString()
  };

  const lateResult = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: paymentA.id,
    verificationResult: lateAuthResult
  });

  // 4. Invariants Assertions:
  // A. Returned route must be LATE_PAYMENT_MANUAL_REVIEW
  assert.equal(lateResult.success, false);
  assert.equal(lateResult.code, "LATE_PAYMENT_MANUAL_REVIEW");
  assert.equal(lateResult.route, "LATE_PAYMENT_MANUAL_REVIEW");

  // B. Payment A must record evidence and be in manual_review
  const updatedPaymentA = await repo.getPaymentById(paymentA.id);
  assert.equal(updatedPaymentA.status, PAYMENT_STATUSES.manualReview);

  // C. Payment attempt evidence must be persisted
  const attempts = await repo.listPaymentAttempts(paymentA.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].verified_transaction_reference, "TXN_LATE_GENUINE_001");
  assert.equal(attempts[0].failure_reason_code, "LATE_PAYMENT_REVIEW");

  // D. Booking A MUST NOT be confirmed (must remain expired)
  const currentBookingA = await repo.getBookingById(bookingA.id);
  assert.equal(currentBookingA.status, "expired");

  // E. Booking B MUST NOT be touched or reclaimed
  const currentBookingB = await repo.getBookingById(bookingB.id);
  assert.equal(currentBookingB.status, "confirmed");
  assert.equal(currentBookingB.customer_id, customerB.id);
});

// ---------------------------------------------------------------------------
// 10. Financial Entitlements Fail-Closed (Strict true + true required)
// ---------------------------------------------------------------------------

test("Phase F: Financial entitlements fail-closed (only true + true can auto-confirm)", async () => {
  const repo = new FakeRepository(buildSeed());
  const staff = repo.staff[0];
  const service = repo.services[0];
  const customer = await repo.insertCustomer({ name: "Ent Customer", phone: "0811112222" });

  const booking = await repo.insertBooking({
    customer_id: customer.id,
    service_id: service.id,
    staff_id: staff.id,
    start_at: "2026-10-01T10:00:00+07:00",
    end_at: "2026-10-01T10:45:00+07:00",
    status: "pending"
  });

  const payment = await repo.insertPayment({
    original_booking_id: booking.id,
    business_id: "biz_ent",
    amount_due: 300,
    status: PAYMENT_STATUSES.pending,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  });

  const validAuthResult = {
    verified: true,
    authoritative: true,
    amountSatang: 30000,
    receiver: { merchantIdentifier: "biz_ent" },
    transactionReference: "TXN_ENT_001",
    transactionAt: new Date().toISOString()
  };

  // 1. true + false -> manual review
  const res1 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { slipVerification: true, autoPaymentConfirmation: false }
  });
  assert.equal(res1.success, false);
  assert.equal(res1.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);
  const p1 = await repo.getPaymentById(payment.id);
  assert.equal(p1.status, PAYMENT_STATUSES.manualReview);
  const b1 = await repo.getBookingById(booking.id);
  assert.equal(b1.status, "pending");

  // 2. false + true -> manual review
  const res2 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { slipVerification: false, autoPaymentConfirmation: true }
  });
  assert.equal(res2.success, false);
  assert.equal(res2.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

  // 3. undefined + true -> manual review
  const res3 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { autoPaymentConfirmation: true }
  });
  assert.equal(res3.success, false);
  assert.equal(res3.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

  // 4. true + undefined -> manual review
  const res4 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { slipVerification: true }
  });
  assert.equal(res4.success, false);
  assert.equal(res4.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

  // 5. null + null -> manual review
  const res5 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { slipVerification: null, autoPaymentConfirmation: null }
  });
  assert.equal(res5.success, false);
  assert.equal(res5.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

  // 6. empty object / error / unknown -> manual review
  const res6 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: {}
  });
  assert.equal(res6.success, false);
  assert.equal(res6.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

  // 7. true + true -> auto-confirms successfully!
  await repo.updatePayment(payment.id, { status: PAYMENT_STATUSES.pending });
  const res7 = await SlipIntakeService.processAuthoritativeNotification(repo, {
    paymentId: payment.id,
    verificationResult: validAuthResult,
    entitlements: { slipVerification: true, autoPaymentConfirmation: true }
  });
  assert.equal(res7.success, true);
  assert.equal(res7.code, "PAYMENT_CONFIRMED");
  const p7 = await repo.getPaymentById(payment.id);
  assert.equal(p7.status, PAYMENT_STATUSES.paid);
  const b7 = await repo.getBookingById(booking.id);
  assert.equal(b7.status, "confirmed");
});

