// Salon Booking OS v1 - Payment Phase H Test Suite
// Covers:
// 1. EasySlip v2 Request Mapping (payload, image, base64, url, matchAmount, checkDuplicate)
// 2. Official Response Normalization (transRef, exact amount/satang, receiver, sender, timestamp)
// 3. Duplicate Detection & Flag Mapping (isDuplicate -> duplicate normalized_result)
// 4. Time Parsing & ISO 8601 Timezone Conversion
// 5. Explicit Error Code Normalization (VALIDATION_ERROR, SLIP_NOT_FOUND, SLIP_PENDING, QUOTA_EXCEEDED, etc.)
// 6. Security & Credential Protection (Zero secret leakage, safe redacted logging)
// 7. Request Idempotency & Safe POST Dispatch (supportsRequestIdempotency = false, no blind retry)
// 8. Strict Authoritative Flag Gate: authoritative defaults strictly to false in Phase H
// 9. Integration with SlipIntakeService & evaluateSlipVerification:
//    - When authoritative = false -> routes strictly to manual_review, never auto-paid
//    - Booking remains pending, no payment_confirmed event emitted
// 10. Live Trial Credential Check (Opt-in via EASYSLIP_TEST_ENABLED=true)

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const {
  PAYMENT_STATUSES,
  PAYMENT_REASON_CODES,
  EasySlipV2Provider,
  DEFAULT_EASYSLIP_BASE_URL,
  DEFAULT_EASYSLIP_ENDPOINT,
  EASYSLIP_ERROR_MAPPING,
  normalizeEasySlipErrorCode,
  SlipProviderTransport,
  SlipTransportError,
  evaluateSlipVerification,
  SlipIntakeService,
  sanitizePayload
} = require("../src/payment");

const { FakeRepository, buildSeed } = require("./fake-repository");

// Helper: generate dummy base64 slip image
const DUMMY_SLIP_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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
// 1. Request Body Construction & Parameter Mapping
// ---------------------------------------------------------------------------

test("EasySlip v2 Request Mapping: prefers payload over image and formats parameters strictly", () => {
  const provider = new EasySlipV2Provider({ apiKey: "test_key" });

  // Case A: Payload (raw QR string)
  const qrString = "00020101021229370016A000000677010111011300668123456785802TH5406300.0053037646304ABCD";
  const bodyA = provider.buildRequestBody({ payload: qrString, matchAmount: 300, checkDuplicate: true });
  assert.equal(bodyA.payload, qrString);
  assert.equal(bodyA.matchAmount, 300);
  assert.equal(bodyA.checkDuplicate, true);
  assert.equal(bodyA.matchAccount, undefined);

  // Case B: Image Buffer fallback -> converted to data URI (PNG detected from magic bytes)
  const bodyB = provider.buildRequestBody({ image: DUMMY_SLIP_IMAGE, matchAmount: 150 });
  assert.ok(bodyB.base64.startsWith("data:image/png;base64,") || bodyB.base64.startsWith("data:image/jpeg;base64,"));
  assert.equal(bodyB.matchAmount, 150);
  assert.equal(bodyB.checkDuplicate, true);

  // Case C: Base64 string directly
  const bodyC = provider.buildRequestBody({ base64: "data:image/png;base64,abc123" });
  assert.equal(bodyC.base64, "data:image/png;base64,abc123");

  // Case D: URL directly
  const bodyD = provider.buildRequestBody({ url: "https://example.com/slip.jpg" });
  assert.equal(bodyD.url, "https://example.com/slip.jpg");

  // Case E: Missing all inputs throws validation error
  assert.throws(() => provider.buildRequestBody({}), /EasySlip v2 request requires one of/);
});

// ---------------------------------------------------------------------------
// 2. Official Success Response Normalization
// ---------------------------------------------------------------------------

test("EasySlip v2 Normalization: maps official success response into normalized contract without floating-point error", () => {
  const provider = new EasySlipV2Provider({ apiKey: "test_key", authoritativeConfirmed: false });

  const officialSuccessResponse = {
    status: 200,
    data: {
      rawSlip: {
        transRef: "20240115014KBANK998811",
        date: "2024-01-15T14:30:00+07:00",
        amount: {
          amount: 2500.75,
          local: { currency: "THB" }
        },
        sender: {
          bank: { id: "014", name: "SCB" },
          account: {
            bank: { type: "SAVINGS", account: "xxx-x-xx987-6" },
            name: { th: "สมชาย รักดี", en: "SOMCHAI RAKDEE" }
          }
        },
        receiver: {
          bank: { id: "004", name: "KBANK" },
          account: {
            bank: { type: "CURRENT", account: "xxx-x-xx123-4" },
            proxy: { type: "NATID", account: "1-xxxx-xxxxx-xx-9" },
            name: { th: "ร้านซาลอน แฮร์บิวตี้", en: "SALON HAIR BEAUTY" }
          }
        }
      },
      matchedAccount: {
        bank: "004",
        account: "xxx-x-xx123-4"
      },
      isDuplicate: false,
      isAmountMatched: true
    }
  };

  const normalized = provider.normalizeResponse(officialSuccessResponse, 200, "local_req_123");

  // Verification invariants
  assert.equal(normalized.verified, true);
  assert.equal(normalized.authoritative, false, "Phase H: authoritative must default to false");
  assert.equal(normalized.provider, "easyslip_v2");
  assert.equal(normalized.providerRequestId, "local_req_123");
  assert.equal(normalized.transactionNamespace, "easyslip_th_bank");
  assert.equal(normalized.transactionReference, "20240115014KBANK998811");
  assert.equal(normalized.amountSatang, 250075, "Amount in satang must be exact 250075");
  assert.equal(normalized.amount, 2500.75);
  assert.equal(normalized.currency, "THB");

  // Receiver identity
  assert.equal(normalized.receiver.bankCode, "004");
  assert.equal(normalized.receiver.accountNumberMasked, "xxx-x-xx123-4");
  assert.equal(normalized.receiver.promptPayIdentifierMasked, "1-xxxx-xxxxx-xx-9");
  assert.equal(normalized.receiver.accountName, "ร้านซาลอน แฮร์บิวตี้");

  // Timestamp
  assert.equal(normalized.transactionAt, new Date("2024-01-15T14:30:00+07:00").toISOString());
  assert.equal(normalized.isDuplicate, false);
  assert.equal(normalized.reasonCode, PAYMENT_REASON_CODES.SUCCESS);
});

// ---------------------------------------------------------------------------
// 3. Duplicate Slip Response Normalization
// ---------------------------------------------------------------------------

test("EasySlip v2 Normalization: maps isDuplicate=true to duplicate normalized_result and reason code", () => {
  const provider = new EasySlipV2Provider({ apiKey: "test_key" });

  const duplicateResponse = {
    status: 200,
    data: {
      rawSlip: {
        transRef: "20240115014KBANK998811",
        date: "2024-01-15T14:30:00+07:00",
        amount: { amount: 300.00, local: { currency: "THB" } }
      },
      isDuplicate: true
    }
  };

  const normalized = provider.normalizeResponse(duplicateResponse, 200, "local_req_dup");
  assert.equal(normalized.verified, false, "Duplicate slip must not be verified=true");
  assert.equal(normalized.isDuplicate, true);
  assert.equal(normalized.normalized_result, "duplicate");
  assert.equal(normalized.reasonCode, PAYMENT_REASON_CODES.DUPLICATE_TRANSACTION);
});

// ---------------------------------------------------------------------------
// 4. Official Error Code Mapping & Sensitive Data Protection
// ---------------------------------------------------------------------------

test("EasySlip v2 Error Mapping: normalizes official vendor error codes without leaking secrets", () => {
  const testCases = [
    { code: "VALIDATION_ERROR", expected: PAYMENT_REASON_CODES.INVALID_SLIP },
    { code: "SLIP_NOT_FOUND", expected: PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND },
    { code: "SLIP_PENDING", expected: "PROVIDER_PENDING" },
    { code: "QUOTA_EXCEEDED", expected: PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE },
    { code: "INVALID_API_KEY", expected: PAYMENT_REASON_CODES.AUTHENTICATION_FAILED },
    { code: "IP_NOT_ALLOWED", expected: PAYMENT_REASON_CODES.AUTHENTICATION_FAILED },
    { code: "RATE_LIMIT_EXCEEDED", expected: PAYMENT_REASON_CODES.RATE_LIMITED },
    { code: "API_SERVER_ERROR", expected: PAYMENT_REASON_CODES.PROVIDER_UNAVAILABLE }
  ];

  for (const tc of testCases) {
    const mapped = normalizeEasySlipErrorCode(tc.code);
    assert.equal(mapped, tc.expected, `Error code ${tc.code} must map to ${tc.expected}`);
  }

  // Provider response normalization on error
  const provider = new EasySlipV2Provider({ apiKey: "test_key" });
  const errorPayload = {
    status: 400,
    code: "SLIP_NOT_FOUND",
    message: "Slip does not exist in clearing system"
  };

  const normalizedError = provider.normalizeResponse(errorPayload, 400, "req_err_1");
  assert.equal(normalizedError.verified, false);
  assert.equal(normalizedError.normalized_result, "provider_error");
  assert.equal(normalizedError.reasonCode, PAYMENT_REASON_CODES.TRANSACTION_NOT_FOUND);
  assert.equal(normalizedError.rawResponse, null, "Raw response must be sanitized and unexposed");
});

// ---------------------------------------------------------------------------
// 5. Safe POST Dispatch & Idempotency Invariant
// ---------------------------------------------------------------------------

test("EasySlip v2 Safe POST Dispatch: supportsRequestIdempotency is strictly false, disabling blind retries", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Map(),
      text: async () => "Upstream error"
    };
  };

  const transport = new SlipProviderTransport({
    fetchFn: mockFetch,
    supportsRequestIdempotency: false,
    maxRetries: 2
  });

  const provider = new EasySlipV2Provider({
    apiKey: "test_key",
    transport
  });

  // Since supportsRequestIdempotency is false, transport must NOT retry POST requests
  await assert.rejects(
    async () => provider.verifySlip({ payload: "test_qr", expectedAmount: 300, expectedReceiver: "004" }),
    (err) => {
      assert.equal(err.code, PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT);
      assert.equal(callCount, 1, "Non-idempotent POST must only be attempted exactly 1 time (no blind retry)");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Strict Authoritative Gate & Fallback to Manual Review
// ---------------------------------------------------------------------------

test("Phase H Authoritative Gate: EasySlip result routes to MANUAL_REVIEW when authoritative=false", () => {
  const provider = new EasySlipV2Provider({ apiKey: "test_key", authoritativeConfirmed: false });

  const rawSuccess = {
    status: 200,
    data: {
      rawSlip: {
        transRef: "TXN_NON_AUTH_123",
        date: "2026-10-01T10:00:00+07:00",
        amount: { amount: 300.00, local: { currency: "THB" } },
        receiver: {
          bank: { id: "004" },
          account: { bank: { account: "xxx-x-xx123-4" }, proxy: { account: "081-xxx-5678" } }
        }
      }
    }
  };

  const normalized = provider.normalizeResponse(rawSuccess, 200);
  assert.equal(normalized.verified, true);
  assert.equal(normalized.authoritative, false, "Phase H invariant: must be non-authoritative");

  const evalResult = evaluateSlipVerification({
    payment: { id: "pay_1", business_id: "biz-1", amount_due: 300 },
    verificationResult: normalized,
    expectedReceiver: { bankCode: "004", accountNumberMasked: "xxx-x-xx123-4" }
  });

  assert.equal(evalResult.eligibleForAutoConfirmation, false);
  assert.equal(evalResult.recommendedStatus, PAYMENT_STATUSES.manualReview);
  assert.equal(evalResult.reasonCode, PAYMENT_REASON_CODES.NON_AUTHORITATIVE_VERIFICATION);
});

// ---------------------------------------------------------------------------
// 7. Full SlipIntakeService End-to-End Flow with FakeRepository
// ---------------------------------------------------------------------------

test("SlipIntakeService with EasySlipV2Provider: records PaymentAttempt, sets manual_review, preserves pending booking", async () => {
  const seed = buildSeed();
  const repo = new FakeRepository(seed);

  const staff = repo.staff[0];
  const service = repo.services[0];
  const customer = await repo.insertCustomer({
    name: "Customer ES",
    phone: "0812345678"
  });

  // Setup pending booking and payment
  const booking = await repo.insertBooking({
    customer_id: customer.id,
    service_id: service.id,
    staff_id: staff.id,
    start_at: "2026-10-01T14:00:00+07:00",
    end_at: "2026-10-01T14:45:00+07:00",
    status: "pending",
    source: "line"
  });

  const payment = await repo.insertPayment({
    business_id: "biz-1",
    original_booking_id: booking.id,
    payment_type: "full_payment",
    provider: "easyslip_v2",
    amount_due: 300.00,
    amountDueSatang: 30000,
    idempotency_key: `idem_es_${Date.now()}`,
    status: PAYMENT_STATUSES.pending,
    created_at: new Date().toISOString()
  });

  // Create EasySlip mock transport returning official success response
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => ({
      status: 200,
      data: {
        rawSlip: {
          transRef: "20261001KBANK8877",
          date: new Date().toISOString(),
          amount: { amount: 300.00, local: { currency: "THB" } },
          receiver: {
            bank: { id: "004" },
            account: { bank: { account: "xxx-x-xx123-4" } }
          }
        },
        isDuplicate: false
      }
    })
  });

  const transport = new SlipProviderTransport({ fetchFn: mockFetch });
  const easySlipProvider = new EasySlipV2Provider({
    apiKey: "dummy_trial_key",
    transport,
    authoritativeConfirmed: false // Strict Phase H constraint
  });

  const session = {
    paymentId: payment.id,
    customerId: customer.id
  };

  const result = await SlipIntakeService.processSlip({
    session,
    messageId: "msg_es_1",
    contentProvider: new MockContentProvider(),
    slipProvider: easySlipProvider,
    repository: repo,
    businessId: { bankCode: "004", accountNumberMasked: "xxx-x-xx123-4" },
    entitlements: { slipVerification: true, autoPaymentConfirmation: true }
  });

  // Verify Domain Decision
  assert.equal(result.stage, "payment_manual_review");
  assert.equal(result.code, "NON_AUTHORITATIVE_MANUAL_REVIEW");
  assert.equal(result.booking, undefined, "Must not return confirmed booking on non-authoritative verification");

  // Verify Repository Records
  const updatedPayment = await repo.getPaymentById(payment.id);
  assert.equal(updatedPayment.status, PAYMENT_STATUSES.manualReview, "Payment must be routed to manual_review");

  const updatedBooking = await repo.getBookingById(booking.id);
  assert.equal(updatedBooking.status, "pending", "Booking must remain pending (not confirmed as paid)");

  // PaymentAttempt row must be persisted
  const attempts = await repo.getPaymentAttempts(payment.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].verification_provider, "easyslip_v2");
  assert.equal(attempts[0].normalized_result, "success");
  assert.equal(attempts[0].verified_transaction_reference, "20261001KBANK8877");
  assert.equal(attempts[0].verified_amount, 300);

  // No payment_confirmed event should exist
  const events = repo.paymentEvents.filter((e) => e.payment_id === payment.id);
  const hasPaidEvent = events.some((e) => e.to_status === PAYMENT_STATUSES.paid);
  assert.equal(hasPaidEvent, false, "No paid event allowed for non-authoritative verification");
});

// ---------------------------------------------------------------------------
// 8. Missing Credential Handling (LIVE_TRIAL_NOT_EXECUTED_NO_CREDENTIAL)
// ---------------------------------------------------------------------------

test("EasySlip v2 Credential Handling: fails closed when API key is unconfigured without printing secrets", async () => {
  const provider = new EasySlipV2Provider({ apiKey: null });
  assert.equal(provider.apiKey, null);

  await assert.rejects(
    async () => provider.verifySlip({ payload: "test_qr", expectedAmount: 100, expectedReceiver: "004" }),
    (err) => {
      assert.equal(err.code, PAYMENT_REASON_CODES.AUTHENTICATION_FAILED);
      assert.ok(err.message.includes("LIVE_TRIAL_NOT_EXECUTED_NO_CREDENTIAL"));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 9. Optional Live Trial Test (Opt-in via EASYSLIP_TEST_ENABLED=true)
// ---------------------------------------------------------------------------

test("EasySlip v2 Optional Live Trial: skips gracefully when EASYSLIP_TEST_ENABLED is not set", async (t) => {
  if (process.env.EASYSLIP_TEST_ENABLED !== "true" || !process.env.EASYSLIP_API_KEY) {
    t.skip("Live EasySlip trial test skipped (EASYSLIP_TEST_ENABLED!=true or EASYSLIP_API_KEY missing)");
    return;
  }

  // If opted in with real test credentials:
  const liveProvider = new EasySlipV2Provider({
    apiKey: process.env.EASYSLIP_API_KEY,
    authoritativeConfirmed: false
  });

  assert.ok(liveProvider.apiKey, "API key is present");
  // Test sanitization ensures no secret leaks in error or log
  const sanitized = sanitizePayload({ key: liveProvider.apiKey, data: "ok" });
  assert.equal(sanitized.key, "[REDACTED]");
});

// ---------------------------------------------------------------------------
// 10. PostgreSQL Integration Test (Docker TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

const shouldRunPostgres = Boolean(process.env.TEST_DATABASE_URL);

test("PostgreSQL Integration: EasySlip v2 provider persists attempt, sets manual_review, leaves booking pending", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");
  const { PgBookingRepository } = require("../src/repositories/pg-booking-repository");

  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    const customerRes = await pool.query(
      `insert into customers(name, phone) values('EasySlip Customer', '0891234567') returning *`
    );
    const customer = customerRes.rows[0];

    const serviceRes = await pool.query(`select * from services limit 1`);
    const service = serviceRes.rows[0];

    const staffRes = await pool.query(`select * from staff limit 1`);
    const staff = staffRes.rows[0];

    const uniqueDay = Math.floor(Math.random() * 20) + 1;
    const slotHour = String(Math.floor(Math.random() * 8) + 9).padStart(2, "0");
    const slotStart = `2026-11-${String(uniqueDay).padStart(2, "0")}T${slotHour}:00:00+07:00`;
    const slotEnd = `2026-11-${String(uniqueDay).padStart(2, "0")}T${slotHour}:45:00+07:00`;

    const bookingRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'line') returning *`,
      [customer.id, service.id, staff.id, slotStart, slotEnd]
    );
    const booking = bookingRes.rows[0];

    const paymentRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-es-pg', $1, 'full_payment', 'promptpay_qr', 450.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [booking.id, `idem_es_pg_${randomUUID()}`]
    );
    const payment = paymentRes.rows[0];

    // Mock transport returning official success response
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({
        status: 200,
        data: {
          rawSlip: {
            transRef: `ES_TXN_${Date.now()}`,
            date: new Date().toISOString(),
            amount: { amount: 450.00, local: { currency: "THB" } },
            receiver: {
              bank: { id: "004" },
              account: { bank: { account: "xxx-x-xx123-4" } }
            }
          },
          isDuplicate: false
        }
      })
    });

    const transport = new SlipProviderTransport({ fetchFn: mockFetch });
    const easySlipProvider = new EasySlipV2Provider({
      apiKey: "dummy_trial_key",
      transport,
      authoritativeConfirmed: false // Phase H constraint
    });

    const uniqueSlipImage = Buffer.from(`fake_slip_bytes_${Date.now()}_${randomUUID()}`);
    class DynamicContentProvider {
      async getImageContent() {
        return {
          buffer: uniqueSlipImage,
          contentType: "image/png",
          contentLength: uniqueSlipImage.length
        };
      }
    }

    const session = {
      paymentId: payment.id,
      customerId: customer.id
    };

    const result = await SlipIntakeService.processSlip({
      session,
      messageId: `msg_es_pg_${randomUUID()}`,
      contentProvider: new DynamicContentProvider(),
      slipProvider: easySlipProvider,
      repository,
      businessId: { bankCode: "004", accountNumberMasked: "xxx-x-xx123-4" },
      entitlements: { slipVerification: true, autoPaymentConfirmation: true }
    });

    // 1. Domain result must route to manual review
    assert.equal(result.stage, "payment_manual_review");
    assert.equal(result.code, "NON_AUTHORITATIVE_MANUAL_REVIEW");

    // 2. Database payment must be in manual_review
    const pgPayment = await repository.getPaymentById(payment.id);
    assert.equal(pgPayment.status, PAYMENT_STATUSES.manualReview);

    // 3. Database booking must remain pending (not confirmed as paid)
    const pgBooking = await repository.getBookingById(booking.id);
    assert.equal(pgBooking.status, "pending");

    // 4. PaymentAttempt row is persisted in PostgreSQL
    const attempts = await repository.getPaymentAttempts(payment.id);
    assert.ok(attempts.length >= 1);
    const verifiedAttempt = attempts.find((a) => a.provider_status === "completed" || a.normalized_result === "success");
    assert.ok(verifiedAttempt);
    assert.equal(verifiedAttempt.verification_provider, "easyslip_v2");
    assert.equal(Number(verifiedAttempt.verified_amount), 450.00);

    // 5. No payment_confirmed event should exist
    const events = await pool.query("select * from payment_events where payment_id = $1", [payment.id]);
    const hasPaid = events.rows.some((e) => e.to_status === PAYMENT_STATUSES.paid);
    assert.equal(hasPaid, false, "PostgreSQL: No paid event emitted for non-authoritative verification");

  } finally {
    await pool.end();
  }
});

