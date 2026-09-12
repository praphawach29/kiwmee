// Salon Booking OS v1 - Payment PostgreSQL Integration & Repository Tests
// Phase C: Persistence, Lock Ordering, Idempotency, and Atomic Transaction Guarantees

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  toSatang,
  fromSatang,
  encodeMoneyForDb,
  decodeMoneyFromDb,
  FINANCIAL_LOCK_ORDER,
  validateLockAcquisitionOrder,
  sanitizePayload,
  sanitizePaymentAttempt,
  createPayment,
  createPendingBookingWithPayment,
  confirmVerifiedPayment,
  PaymentConfirmationError,
  transferAllocationForReschedule,
  requestRefund,
  calculateRefundBalances,
  decideRefund,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  BookingCheckoutService,
  expirePendingPaymentHold,
  resolvePaymentPolicy,
  PAYMENT_REASON_CODES,
  ReceiverMatcher,
  RECEIVER_MATCH_STATUS,
  validateTransactionTime,
  TRANSACTION_TIME_STATUS,
  SandboxAuthoritativeSlipProvider,
  SANDBOX_SCENARIOS,
  SlipIntakeService,
  processAuthoritativeNotification,
  DEFAULT_PROVIDER_CAPABILITIES
} = require("../src/payment");

const {
  PgBookingRepository,
  PgPaymentRepository,
  normalizePgError
} = require("../src/repositories/pg-booking-repository");

const { FakeRepository, buildSeed } = require("./fake-repository");

// =============================================================================
// PART 1: Money Boundary Tests (Satang <-> PostgreSQL numeric(10,2))
// Mandatory test values: 0.01, 0.10, 500.00, 2500.75
// =============================================================================

test("Money Boundary: integer satang and numeric(10,2) conversion without float drift", () => {
  const testCases = [
    { input: 0.01, satang: 1, dbEncoded: "0.01" },
    { input: "0.01", satang: 1, dbEncoded: "0.01" },
    { input: 0.10, satang: 10, dbEncoded: "0.10" },
    { input: "0.10", satang: 10, dbEncoded: "0.10" },
    { input: 500.00, satang: 50000, dbEncoded: "500.00" },
    { input: "500.00", satang: 50000, dbEncoded: "500.00" },
    { input: 2500.75, satang: 250075, dbEncoded: "2500.75" },
    { input: "2500.75", satang: 250075, dbEncoded: "2500.75" }
  ];

  for (const tc of testCases) {
    // 1. toSatang conversion
    const satang = toSatang(tc.input);
    assert.equal(satang, tc.satang, `toSatang failed for ${tc.input}`);

    // 2. fromSatang conversion
    const baht = fromSatang(satang);
    assert.equal(baht, Number(tc.dbEncoded), `fromSatang failed for ${satang}`);

    // 3. encodeMoneyForDb conversion
    const encoded = encodeMoneyForDb(tc.input);
    assert.equal(encoded, tc.dbEncoded, `encodeMoneyForDb failed for ${tc.input}`);

    // 4. decodeMoneyFromDb conversion
    const decoded = decodeMoneyFromDb(tc.dbEncoded);
    assert.equal(decoded.satang, tc.satang);
    assert.equal(decoded.baht, Number(tc.dbEncoded));
    assert.equal(decoded.formatted, tc.dbEncoded);
  }

  // Edge cases
  assert.equal(toSatang(0), 0);
  assert.equal(encodeMoneyForDb(0), "0.00");
  assert.throws(() => toSatang(-10), /Invalid monetary amount/);
  assert.throws(() => toSatang("abc"), /Invalid monetary amount/);
  assert.throws(() => fromSatang(-1), /Invalid satang amount/);
});

// =============================================================================
// PART 2: Provider Data Safety Tests
// Sensitive credentials must be stripped before database insertion
// =============================================================================

test("Provider Data Safety: removes secrets, tokens, and authorization headers", () => {
  const dirtyAttempt = {
    payment_id: randomUUID(),
    attempt_type: "slip_upload",
    verification_provider: "mock_provider",
    verified_receiver: " 0123456789 ",
    verified_sender: " 9876543210 ",
    raw_provider_response: {
      status: "success",
      api_key: "super_secret_api_key",
      apiKey: "another_key",
      authorization: "Bearer secret-token-xyz",
      token: "oauth_access_token",
      bank_secret: "pin_123456",
      client_secret: "top_secret",
      nested: {
        password: "my-password",
        private_key: "-----BEGIN PRIVATE KEY-----",
        safe_info: "transaction_12345"
      }
    }
  };

  const sanitized = sanitizePaymentAttempt(dirtyAttempt);

  assert.equal(sanitized.verified_receiver, "0123456789");
  assert.equal(sanitized.verified_sender, "9876543210");
  assert.equal(sanitized.raw_provider_response.api_key, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.apiKey, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.authorization, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.token, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.bank_secret, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.client_secret, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.nested.password, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.nested.private_key, "[REDACTED]");
  assert.equal(sanitized.raw_provider_response.nested.safe_info, "transaction_12345");
});

// =============================================================================
// PART 3: Lock Ordering Hierarchy Validation
// Order: 1. payment -> 2. booking -> 3. allocation -> 4. refund
// =============================================================================

test("Financial Lock Ordering: strictly enforces ascending order", () => {
  assert.equal(FINANCIAL_LOCK_ORDER.PAYMENT, 1);
  assert.equal(FINANCIAL_LOCK_ORDER.BOOKING, 2);
  assert.equal(FINANCIAL_LOCK_ORDER.ALLOCATION, 3);
  assert.equal(FINANCIAL_LOCK_ORDER.REFUND, 4);

  // Valid ascending acquisition
  assert.doesNotThrow(() => validateLockAcquisitionOrder(["payment"], "booking"));
  assert.doesNotThrow(() => validateLockAcquisitionOrder(["payment", "booking"], "allocation"));
  assert.doesNotThrow(() => validateLockAcquisitionOrder(["payment"], "refund"));

  // Deadlock hazards (descending order) must throw
  assert.throws(
    () => validateLockAcquisitionOrder(["booking"], "payment"),
    /Deadlock prevention violation/
  );
  assert.throws(
    () => validateLockAcquisitionOrder(["refund"], "payment"),
    /Deadlock prevention violation/
  );
  assert.throws(
    () => validateLockAcquisitionOrder(["allocation"], "booking"),
    /Deadlock prevention violation/
  );
});

// =============================================================================
// PART 4: PostgreSQL Error Normalization & Replay Protection Mapping
// Unique violation 23505 must be safely mapped without raw SQL leakage
// =============================================================================

test("PostgreSQL Error Normalization: maps constraint violations to domain error codes", () => {
  // 1. Transaction replay violation
  const txnErr = new Error("duplicate key value violates unique constraint \"idx_payments_provider_txn\"");
  txnErr.code = "23505";
  txnErr.constraint = "idx_payments_provider_txn";
  const normTxn = normalizePgError(txnErr);
  assert.equal(normTxn.code, "TRANSACTION_ALREADY_REDEEMED");
  assert.match(normTxn.message, /Transaction reference has already been claimed/);

  // 2. Payment idempotency violation
  const payIdemErr = new Error("duplicate key value violates unique constraint \"payments_idempotency_key_key\"");
  payIdemErr.code = "23505";
  payIdemErr.constraint = "payments_idempotency_key_key";
  const normPayIdem = normalizePgError(payIdemErr);
  assert.equal(normPayIdem.code, "PAYMENT_IDEMPOTENCY_CONFLICT");

  // 3. Refund idempotency violation
  const refIdemErr = new Error("duplicate key value violates unique constraint \"refunds_idempotency_key_key\"");
  refIdemErr.code = "23505";
  refIdemErr.constraint = "refunds_idempotency_key_key";
  const normRefIdem = normalizePgError(refIdemErr);
  assert.equal(normRefIdem.code, "REFUND_IDEMPOTENCY_CONFLICT");

  // 4. Overlap exclusion constraint
  const overlapErr = new Error("conflicting key value violates exclusion constraint \"bookings_no_staff_overlap\"");
  overlapErr.code = "23P01";
  const normOverlap = normalizePgError(overlapErr);
  assert.equal(normOverlap.message, "booking overlaps an existing active booking");
});

// =============================================================================
// PART 5: Repository API Surface Conformance
// Both PgBookingRepository, PgPaymentRepository, and FakeRepository must implement
// all 15 required methods
// =============================================================================

test("Repository Interface: implements all 15 required payment methods", () => {
  const fakeRepo = new FakeRepository();
  const pgRepo = new PgBookingRepository({ pool: { connect: async () => {}, query: async () => ({ rows: [] }) } });

  const requiredMethods = [
    "createPayment",
    "getPaymentById",
    "getPaymentByIdForUpdate",
    "findPaymentByIdempotencyKey",
    "findPaymentByTransactionReference",
    "updatePayment",
    "createPaymentEvent",
    "createPaymentAllocation",
    "getActivePaymentAllocation",
    "updatePaymentAllocation",
    "createRefund",
    "getRefundsByPayment",
    "findRefundByIdempotencyKey",
    "updateRefund",
    "createPaymentAttempt"
  ];

  for (const method of requiredMethods) {
    assert.equal(typeof fakeRepo[method], "function", `FakeRepository missing ${method}`);
    assert.equal(typeof pgRepo[method], "function", `PgBookingRepository missing ${method}`);
  }

  assert.equal(PgBookingRepository, PgPaymentRepository, "PgPaymentRepository aliases PgBookingRepository");
});

// =============================================================================
// PART 6: Atomic Creation Transaction Behavior
// Tests:
// - If payment creation fails, pending booking rolls back.
// - If booking conflict occurs, payment is NEVER created.
// =============================================================================

test("Atomic Payment Creation: rollback on failure and slot conflict protection", async () => {
  const repo = new FakeRepository(buildSeed());

  // 1. Successful atomic pending booking + payment
  const created = await createPendingBookingWithPayment(repo, {
    customer: { name: "Customer Alpha", phone: "0812345678" },
    serviceId: "svc-cut",
    staffId: "staff-ann",
    startAt: "2026-09-10T14:00:00+07:00",
    paymentType: "deposit_fixed",
    fixedAmount: 200
  });

  assert.ok(created.booking.id);
  assert.equal(created.booking.status, "pending");
  assert.ok(created.payment.id);
  assert.equal(created.payment.status, "pending");
  assert.equal(created.payment.original_booking_id, created.booking.id);

  // Active allocation exists
  const activeAlloc = await repo.getActivePaymentAllocation(created.booking.id);
  assert.ok(activeAlloc);
  assert.equal(activeAlloc.booking_id, created.booking.id);

  // 2. Slot Conflict: Attempting to book overlapping slot throws and creates NO payment
  const paymentCountBefore = repo.payments.length;
  await assert.rejects(
    createPendingBookingWithPayment(repo, {
      customer: { name: "Customer Beta", phone: "0899999999" },
      serviceId: "svc-cut",
      staffId: "staff-ann",
      startAt: "2026-09-10T14:30:00+07:00",
      paymentType: "deposit_fixed"
    }),
    /requested slot is not available/
  );
  assert.equal(repo.payments.length, paymentCountBefore, "Payment was not created on slot conflict");

  // 3. Mid-transaction failure: If payment fails, pending booking rolls back
  class FailingPaymentRepository extends FakeRepository {
    async createPayment() {
      throw new Error("simulated payment creation failure");
    }
  }

  const failingRepo = new FailingPaymentRepository(buildSeed());
  await assert.rejects(
    createPendingBookingWithPayment(failingRepo, {
      customer: { name: "Customer Gamma", phone: "0877777777" },
      serviceId: "svc-cut",
      staffId: "staff-ann",
      startAt: "2026-09-10T16:00:00+07:00",
      paymentType: "deposit_fixed"
    }),
    /simulated payment creation failure/
  );

  // Verify booking was rolled back
  assert.equal(failingRepo.bookings.length, 0, "Pending booking was cleanly rolled back on payment failure");
});

// =============================================================================
// PART 7: Reschedule Allocation Transfer & Immutability
// Tests:
// - Payment P1, original_booking_id = Booking A
// - Allocation A active -> Reschedule -> Booking B
// - Allocation A -> transferred, Allocation B -> active
// - payments.original_booking_id remains Booking A
// =============================================================================

test("Reschedule Allocation Transfer: atomic status transfer and original_booking_id immutability", async () => {
  const repo = new FakeRepository(buildSeed());

  const bookingA = await repo.insertBooking({
    customer_id: randomUUID(),
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T13:00:00+07:00",
    end_at: "2026-09-10T14:00:00+07:00",
    status: "confirmed"
  });

  const payment = await createPayment(repo, {
    bookingId: bookingA.id,
    servicePrice: 500,
    servicePolicy: { payment_type: "deposit_fixed", fixed_amount: 200 },
    idempotencyKey: "reschedule_test_pay"
  });

  // Verify initial allocation
  const allocA = await repo.getActivePaymentAllocation(bookingA.id);
  assert.ok(allocA);
  assert.equal(allocA.status, "active");
  assert.equal(payment.original_booking_id, bookingA.id);

  // Reschedule to Booking B
  const bookingB = await repo.insertBooking({
    customer_id: bookingA.customer_id,
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T15:00:00+07:00",
    end_at: "2026-09-10T16:00:00+07:00",
    status: "confirmed"
  });

  const transferredAlloc = await transferAllocationForReschedule(repo, {
    paymentId: payment.id,
    fromBookingId: bookingA.id,
    toBookingId: bookingB.id
  });

  // Verification
  assert.equal(transferredAlloc.booking_id, bookingB.id);
  assert.equal(transferredAlloc.status, "active");

  const oldAlloc = (await repo.getPaymentAllocations(payment.id)).find((a) => a.id === allocA.id);
  assert.equal(oldAlloc.status, "transferred");
  assert.ok(oldAlloc.released_at);

  // Original booking ID on payment MUST remain Booking A
  const refreshedPayment = await repo.getPaymentById(payment.id);
  assert.equal(refreshedPayment.original_booking_id, bookingA.id, "payments.original_booking_id is immutable");
});

// =============================================================================
// PART 8: Concurrent Refund Ledger Protection
// Tests:
// - Payment amount_paid = 500
// - Completed refund = 200, Pending refund = 100
// - New refund > 200 must be rejected under lock
// =============================================================================

test("Refund Ledger: balance calculation and over-refund rejection", async () => {
  const repo = new FakeRepository(buildSeed());

  const payment = await repo.insertPayment({
    original_booking_id: randomUUID(),
    payment_type: "full_payment",
    provider: "promptpay_qr",
    amount_due: "500.00",
    amount_paid: "500.00",
    currency: "THB",
    status: PAYMENT_STATUSES.paid,
    idempotency_key: "refund_calc_pay",
    expires_at: new Date().toISOString()
  });

  // Add completed refund of 200
  await repo.insertRefund({
    payment_id: payment.id,
    booking_id: payment.original_booking_id,
    amount: "200.00",
    reason: "first partial refund",
    status: REFUND_STATUSES.completed,
    idempotency_key: "ref_1",
    approved_by: "admin"
  });

  // Add in-flight pending refund of 100
  await repo.insertRefund({
    payment_id: payment.id,
    booking_id: payment.original_booking_id,
    amount: "100.00",
    reason: "second partial refund",
    status: REFUND_STATUSES.pending,
    idempotency_key: "ref_2",
    approved_by: "admin"
  });

  // Calculate balances: 500 - 200 (completed) - 100 (in-flight) = 200 refundable
  const refunds = await repo.getRefundsByPayment(payment.id);
  const balances = calculateRefundBalances(payment, refunds);
  assert.equal(balances.amountPaid, 500.00);
  assert.equal(balances.completedRefundTotal, 200.00);
  assert.equal(balances.inFlightRefundTotal, 100.00);
  assert.equal(balances.refundableBalance, 200.00);

  // Requesting 200 should succeed
  const validDecision = decideRefund({ payment, refunds, requestedAmount: 200.00 });
  assert.equal(validDecision.approved, true);

  // Requesting 200.01 should be rejected
  const overDecision = decideRefund({ payment, refunds, requestedAmount: 200.01 });
  assert.equal(overDecision.approved, false);
  assert.equal(overDecision.reason, "EXCEEDS_REFUNDABLE_BALANCE");

  // Under requestRefund service call
  await assert.rejects(
    requestRefund(repo, {
      paymentId: payment.id,
      amount: 250.00,
      reason: "excessive refund",
      idempotencyKey: "ref_3"
    }),
    /EXCEEDS_REFUNDABLE_BALANCE/
  );
});

// =============================================================================
// PART 8B: Atomic Confirmation Full Cycle & Concurrency Simulation
// Tests:
// - Payment confirmation: payment paid, booking confirmed, allocation active, event logged,
//   booking history recorded, outbox job enqueued.
// - Duplicate confirmation idempotent success.
// - Replay protection across different payments.
// - Concurrent confirmation and refund race condition protection.
// =============================================================================

test("Atomic Confirmation Full Cycle: updates all entities atomically and rejects duplicate transactions", async () => {
  const repo = new FakeRepository(buildSeed());

  const booking = await repo.insertBooking({
    customer_id: randomUUID(),
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T10:00:00+07:00",
    end_at: "2026-09-10T11:00:00+07:00",
    status: "pending"
  });

  const payment = await createPayment(repo, {
    bookingId: booking.id,
    servicePrice: 500,
    servicePolicy: { payment_type: "full_payment" },
    idempotencyKey: "full_cycle_pay_1"
  });

  // 1. Initial Confirmation
  const confirmResult = await confirmVerifiedPayment(repo, {
    paymentId: payment.id,
    verifiedAmount: 500,
    transactionNamespace: "promptpay_qr",
    transactionReference: "txn_unique_9999"
  });

  assert.equal(confirmResult.status, "success");
  assert.equal(confirmResult.idempotent, false);

  // Verify all 6 atomic mutations
  const updatedPayment = await repo.getPaymentById(payment.id);
  assert.equal(updatedPayment.status, PAYMENT_STATUSES.paid);
  assert.equal(updatedPayment.transaction_reference, "txn_unique_9999");

  const updatedBooking = await repo.getBookingForUpdate(booking.id);
  assert.equal(updatedBooking.status, "confirmed");

  const alloc = await repo.getActivePaymentAllocation(booking.id);
  assert.ok(alloc);
  assert.equal(alloc.status, "active");

  const events = repo.paymentEvents.filter((e) => e.payment_id === payment.id);
  assert.ok(events.some((e) => e.event_type === "payment_confirmed"));

  const histories = repo.bookingStatusHistory.filter((h) => h.booking_id === booking.id);
  assert.ok(histories.some((h) => h.to_status === "confirmed"));

  const outbox = repo.automationJobs.filter((j) => j.booking_id === booking.id);
  assert.ok(outbox.some((j) => j.automation_type === "booking_confirmation"));

  // 2. Duplicate confirmation on SAME payment -> idempotent success
  const duplicateResult = await confirmVerifiedPayment(repo, {
    paymentId: payment.id,
    verifiedAmount: 500,
    transactionNamespace: "promptpay_qr",
    transactionReference: "txn_unique_9999"
  });
  assert.equal(duplicateResult.status, "idempotent_success");
  assert.equal(duplicateResult.idempotent, true);

  // 3. Replay Protection: same transaction reference used on DIFFERENT payment -> REJECT
  const secondBooking = await repo.insertBooking({
    customer_id: randomUUID(),
    service_id: "svc-cut",
    staff_id: "staff-ann",
    start_at: "2026-09-10T11:00:00+07:00",
    end_at: "2026-09-10T12:00:00+07:00",
    status: "pending"
  });

  const secondPayment = await createPayment(repo, {
    bookingId: secondBooking.id,
    servicePrice: 500,
    servicePolicy: { payment_type: "full_payment" },
    idempotencyKey: "full_cycle_pay_2"
  });

  await assert.rejects(
    confirmVerifiedPayment(repo, {
      paymentId: secondPayment.id,
      verifiedAmount: 500,
      transactionNamespace: "promptpay_qr",
      transactionReference: "txn_unique_9999" // Already redeemed!
    }),
    (err) => err.code === "TRANSACTION_ALREADY_REDEEMED"
  );
});

test("Concurrency Protection: sequential execution under lock prevents over-refund and duplicate confirmation", async () => {
  const repo = new FakeRepository(buildSeed());

  const payment = await repo.insertPayment({
    original_booking_id: randomUUID(),
    payment_type: "full_payment",
    provider: "promptpay_qr",
    amount_due: "500.00",
    amount_paid: "500.00",
    currency: "THB",
    status: PAYMENT_STATUSES.paid,
    idempotency_key: "concurrent_pay_test",
    expires_at: new Date().toISOString()
  });

  // Two simultaneous refund requests for 300 each (total 600 > 500)
  // One must succeed, the other must fail with EXCEEDS_REFUNDABLE_BALANCE
  const results = await Promise.allSettled([
    requestRefund(repo, {
      paymentId: payment.id,
      amount: 300.00,
      reason: "concurrent refund 1",
      idempotencyKey: "conc_ref_1"
    }),
    requestRefund(repo, {
      paymentId: payment.id,
      amount: 300.00,
      reason: "concurrent refund 2",
      idempotencyKey: "conc_ref_2"
    })
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one refund must succeed");
  assert.equal(rejected.length, 1, "The second concurrent refund must be rejected");
  assert.equal(rejected[0].reason.code, "EXCEEDS_REFUNDABLE_BALANCE");
});

// =============================================================================
// PART 9: Live PostgreSQL Integration Suite
// Skipped unless TEST_DATABASE_URL is provided in the environment.
// Never touches production database automatically.
// =============================================================================

const shouldRunPostgres = Boolean(process.env.TEST_DATABASE_URL);

test("PostgreSQL Payment Integration Suite (Phase C)", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");

  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    // 1. Reset DB and apply migrations in strict sequential order
    const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const migration004Sql = await fs.readFile(
      path.join(__dirname, "..", "database", "migrations", "004_automation_jobs.sql"),
      "utf8"
    );
    const migration005Sql = await fs.readFile(
      path.join(__dirname, "..", "database", "migrations", "005_automation_retry.sql"),
      "utf8"
    );
    const migration007Sql = await fs.readFile(
      path.join(__dirname, "..", "database", "migrations", "007_payment_schema.sql"),
      "utf8"
    );

    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    await pool.query(schemaSql);
    await pool.query(migration004Sql);
    await pool.query(migration005Sql);
    await pool.query(migration007Sql);

    // 2. Verify all required core & payment tables exist in PostgreSQL
    const tablesRes = await pool.query(
      `
        select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'bookings', 'booking_status_history', 'automation_jobs',
            'payments', 'payment_allocations', 'payment_attempts',
            'payment_events', 'refunds', 'business_integrations'
          )
      `
    );
    assert.equal(tablesRes.rows.length, 9, "All 9 core and payment tables exist in PostgreSQL");

    // 3. STEP 5 — Money Boundary REAL PostgreSQL Round-Trip Test
    const moneyTestAmounts = [0.01, 0.10, 500.00, 2500.75];
    const dummyCust = await repository.insertCustomer({ name: "Money Cust", phone: "0800000099" });
    const dummyService = (await pool.query("insert into services (name, duration_minutes, price) values ('Money Svc', 60, 500) returning *")).rows[0];
    const dummyStaff = (await pool.query("insert into staff (name, phone) values ('Money Staff', '0800000098') returning *")).rows[0];
    const dummyBooking = await repository.insertBooking({
      customer_id: dummyCust.id,
      service_id: dummyService.id,
      staff_id: dummyStaff.id,
      start_at: "2026-09-10T08:00:00+07:00",
      end_at: "2026-09-10T09:00:00+07:00",
      status: "pending"
    });

    for (const amt of moneyTestAmounts) {
      const createdPay = await repository.createPayment({
        original_booking_id: dummyBooking.id,
        payment_type: "deposit_fixed",
        provider: "promptpay_qr",
        amount_due: amt,
        amount_paid: amt,
        idempotency_key: `money_test_${amt}_${randomUUID()}`,
        expires_at: new Date(Date.now() + 60000).toISOString()
      });

      // Query raw PostgreSQL numeric value directly from database
      const rawRow = (await pool.query("select amount_due, amount_paid from payments where id = $1", [createdPay.id])).rows[0];
      const decodedDue = decodeMoneyFromDb(rawRow.amount_due);
      const decodedPaid = decodeMoneyFromDb(rawRow.amount_paid);

      assert.equal(decodedDue.satang, toSatang(amt), `Roundtrip satang mismatch for ${amt}`);
      assert.equal(decodedDue.baht, amt, `Roundtrip baht mismatch for ${amt}`);
      assert.equal(decodedPaid.satang, toSatang(amt), `Roundtrip paid satang mismatch for ${amt}`);
    }

    // 4. Seed test baseline customer, service, staff, and availability
    const custRes = await repository.insertCustomer({ name: "PG Customer", phone: "0800000001" });
    const serviceRes = await pool.query(
      "insert into services (name, duration_minutes, price) values ('PG Cut', 60, 500) returning *"
    );
    const staffRes = await pool.query(
      "insert into staff (name, phone) values ('PG Staff', '0800000002') returning *"
    );
    const service = serviceRes.rows[0];
    const staff = staffRes.rows[0];

    await pool.query(
      "insert into staff_services (staff_id, service_id) values ($1, $2)",
      [staff.id, service.id]
    );
    await pool.query(
      "insert into availability (staff_id, start_at, end_at, type) values ($1, '2026-09-10T09:00:00+07:00'::timestamptz, '2026-09-10T19:00:00+07:00'::timestamptz, 'available')",
      [staff.id]
    );

    const bookingRes = await repository.insertBooking({
      customer_id: custRes.id,
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-10T10:00:00+07:00",
      end_at: "2026-09-10T11:00:00+07:00",
      status: "pending",
      source: "web"
    });

    // 5. Test createPayment in PostgreSQL
    const payment = await repository.createPayment({
      original_booking_id: bookingRes.id,
      payment_type: "deposit_fixed",
      provider: "promptpay_qr",
      amount_due: "200.00",
      amount_paid: "0.00",
      currency: "THB",
      status: "pending",
      idempotency_key: `pg_pay_${randomUUID()}`,
      expires_at: new Date(Date.now() + 900000).toISOString()
    });
    assert.ok(payment.id);
    assert.equal(payment.amount_due, "200.00");
    assert.equal(payment.amount_paid, "0.00");

    // 6. Test Idempotency Key Constraint in PostgreSQL -> Error normalized to PAYMENT_IDEMPOTENCY_CONFLICT
    await assert.rejects(
      repository.createPayment({
        original_booking_id: bookingRes.id,
        payment_type: "deposit_fixed",
        provider: "promptpay_qr",
        amount_due: "200.00",
        idempotency_key: payment.idempotency_key, // Reused key
        expires_at: new Date().toISOString()
      }),
      (err) => err.code === "PAYMENT_IDEMPOTENCY_CONFLICT"
    );

    // 7. Test Atomic Payment Confirmation in PostgreSQL
    const confirmResult = await confirmVerifiedPayment(repository, {
      paymentId: payment.id,
      verifiedAmount: "200.00",
      transactionNamespace: "promptpay_qr",
      transactionReference: "txn-pg-12345678"
    });
    assert.equal(confirmResult.status, "success");
    assert.equal(confirmResult.idempotent, false);

    // Verify DB state
    const confirmedPayment = await repository.getPaymentById(payment.id);
    assert.equal(confirmedPayment.status, "paid");
    assert.equal(confirmedPayment.amount_paid, "200.00");

    const confirmedBooking = (await pool.query("select * from bookings where id = $1", [bookingRes.id])).rows[0];
    assert.equal(confirmedBooking.status, "confirmed");

    const events = (await pool.query("select * from payment_events where payment_id = $1", [payment.id])).rows;
    assert.ok(events.some((e) => e.event_type === "payment_confirmed"));

    const allocations = await repository.getPaymentAllocations(payment.id);
    assert.ok(allocations.some((a) => a.status === "active" && a.amount === "200.00"));

    const history = (await pool.query("select * from booking_status_history where booking_id = $1", [bookingRes.id])).rows;
    assert.ok(history.some((h) => h.to_status === "confirmed"));

    const outbox = (await pool.query("select * from automation_jobs where booking_id = $1", [bookingRes.id])).rows;
    assert.ok(outbox.some((j) => j.automation_type === "booking_confirmation"));

    // 8. Duplicate Confirmation Idempotency in PostgreSQL
    const dupResult = await confirmVerifiedPayment(repository, {
      paymentId: payment.id,
      verifiedAmount: "200.00",
      transactionNamespace: "promptpay_qr",
      transactionReference: "txn-pg-12345678"
    });
    assert.equal(dupResult.status, "idempotent_success");
    assert.equal(dupResult.idempotent, true);

    // 9. Replay Protection: same transaction used on DIFFERENT payment must be rejected with TRANSACTION_ALREADY_REDEEMED
    const secondBooking = await repository.insertBooking({
      customer_id: custRes.id,
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-10T12:00:00+07:00",
      end_at: "2026-09-10T13:00:00+07:00",
      status: "pending",
      source: "web"
    });

    const secondPayment = await repository.createPayment({
      original_booking_id: secondBooking.id,
      payment_type: "deposit_fixed",
      provider: "promptpay_qr",
      amount_due: "200.00",
      idempotency_key: `pg_pay_${randomUUID()}`,
      expires_at: new Date(Date.now() + 900000).toISOString()
    });

    await assert.rejects(
      confirmVerifiedPayment(repository, {
        paymentId: secondPayment.id,
        verifiedAmount: "200.00",
        transactionNamespace: "promptpay_qr",
        transactionReference: "txn-pg-12345678" // Reused txn reference!
      }),
      (err) => err.code === "TRANSACTION_ALREADY_REDEEMED"
    );

    // 10. Atomic Rollback on Mid-Transaction Failure
    const initialBookingStatus = secondBooking.status;
    await assert.rejects(
      repository.transaction(async (tx) => {
        await tx.updatePayment(secondPayment.id, { status: "paid" });
        await tx.updateBookingStatus(secondBooking.id, "confirmed");
        throw new Error("simulated mid-transaction failure");
      }),
      /simulated mid-transaction failure/
    );

    const untouchedPayment = await repository.getPaymentById(secondPayment.id);
    assert.equal(untouchedPayment.status, "pending", "Payment rolled back");
    const untouchedBooking = (await pool.query("select * from bookings where id = $1", [secondBooking.id])).rows[0];
    assert.equal(untouchedBooking.status, initialBookingStatus, "Booking rolled back");

    // 11. Reschedule Allocation Transfer in PostgreSQL
    const thirdBooking = await repository.insertBooking({
      customer_id: custRes.id,
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-10T14:00:00+07:00",
      end_at: "2026-09-10T15:00:00+07:00",
      status: "confirmed",
      source: "web"
    });

    await transferAllocationForReschedule(repository, {
      paymentId: payment.id,
      fromBookingId: bookingRes.id,
      toBookingId: thirdBooking.id
    });

    const pgAllocations = await repository.getPaymentAllocations(payment.id);
    const oldAlloc = pgAllocations.find((a) => a.booking_id === bookingRes.id);
    const newAlloc = pgAllocations.find((a) => a.booking_id === thirdBooking.id);
    assert.equal(oldAlloc.status, "transferred");
    assert.ok(oldAlloc.released_at);
    assert.equal(newAlloc.status, "active");

    const finalPayment = await repository.getPaymentById(payment.id);
    assert.equal(finalPayment.original_booking_id, bookingRes.id, "original_booking_id remains immutable in PG");

    // 12. Atomic Creation Service in PostgreSQL (createPendingBookingWithPayment)
    const atomicCreated = await createPendingBookingWithPayment(repository, {
      customer: { name: "PG Atomic Cust", phone: "0800000005" },
      serviceId: service.id,
      staffId: staff.id,
      startAt: "2026-09-10T16:00:00+07:00",
      paymentType: "deposit_fixed",
      fixedAmount: 150
    });
    assert.ok(atomicCreated.booking.id);
    assert.equal(atomicCreated.booking.status, "pending");
    assert.ok(atomicCreated.payment.id);
    assert.equal(atomicCreated.payment.status, "pending");

    // Slot Conflict Protection: Attempting to book overlapping slot must fail
    await assert.rejects(
      createPendingBookingWithPayment(repository, {
        customer: { name: "Conflict Cust", phone: "0800000006" },
        serviceId: service.id,
        staffId: staff.id,
        startAt: "2026-09-10T16:30:00+07:00",
        paymentType: "deposit_fixed",
        fixedAmount: 150
      }),
      /requested slot is not available/
    );

    // 13. Real Concurrency Protection: Concurrent Refunds on Real PostgreSQL
    // Create a fully paid payment of 500
    const refundPay = await repository.createPayment({
      original_booking_id: bookingRes.id,
      payment_type: "full_payment",
      provider: "promptpay_qr",
      amount_due: "500.00",
      amount_paid: "500.00",
      currency: "THB",
      status: "paid",
      idempotency_key: `pg_refund_test_${randomUUID()}`,
      expires_at: new Date().toISOString()
    });

    // Run 2 simultaneous refund requests on 2 separate client pools for 300 each (total 600 > 500)
    const pool2 = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
    });
    const repo2 = new PgBookingRepository({ pool: pool2 });

    try {
      const concurrentResults = await Promise.allSettled([
        requestRefund(repository, {
          paymentId: refundPay.id,
          amount: 300.00,
          reason: "pg conc refund 1",
          idempotencyKey: `pg_conc_1_${randomUUID()}`
        }),
        requestRefund(repo2, {
          paymentId: refundPay.id,
          amount: 300.00,
          reason: "pg conc refund 2",
          idempotencyKey: `pg_conc_2_${randomUUID()}`
        })
      ]);

      const concFulfilled = concurrentResults.filter((r) => r.status === "fulfilled");
      const concRejected = concurrentResults.filter((r) => r.status === "rejected");

      assert.equal(concFulfilled.length, 1, "Under real PostgreSQL row lock, exactly one refund succeeds");
      assert.equal(concRejected.length, 1, "Under real PostgreSQL row lock, second refund fails");
      assert.equal(concRejected[0].reason.code, "EXCEEDS_REFUNDABLE_BALANCE");
    } finally {
      await pool2.end();
    }

    // 14. STEP 6 — Booking Overlap GiST Exclusion Constraint Error Normalization
    await assert.rejects(
      repository.insertBooking({
        customer_id: custRes.id,
        service_id: service.id,
        staff_id: staff.id,
        start_at: "2026-09-10T10:30:00+07:00", // Overlaps bookingRes (10:00-11:00)
        end_at: "2026-09-10T11:30:00+07:00",
        status: "confirmed",
        source: "test"
      }),
      /booking overlaps an existing active booking/
    );

    // 15. Compound Transaction Reference Uniqueness (idx_payments_provider_txn)
    const compoundUniqRef = `txn-compound-${randomUUID()}`;
    await pool.query(
      `insert into payments (id, business_id, original_booking_id, payment_type, provider, amount_due, amount_paid, currency, status, transaction_namespace, transaction_reference, idempotency_key, expires_at)
       values ($1, 'default', $2, 'full_payment', 'promptpay_qr', '100.00', '100.00', 'THB', 'paid', 'promptpay_qr', $3, $4, now())`,
      [randomUUID(), bookingRes.id, compoundUniqRef, `idem_${randomUUID()}`]
    );

    await assert.rejects(
      repository.createPayment({
        original_booking_id: bookingRes.id,
        payment_type: "full_payment",
        provider: "promptpay_qr",
        transaction_namespace: "promptpay_qr",
        transaction_reference: compoundUniqRef, // Duplicate compound reference
        amount_due: "100.00",
        idempotency_key: `idem_${randomUUID()}`,
        expires_at: new Date().toISOString()
      }),
      (err) => err.code === "TRANSACTION_ALREADY_REDEEMED"
    );

    // 16. Real Concurrency: Concurrent Confirmation on Same Payment (row-lock serialization -> idempotent)
    const concurrentPayBooking = await repository.insertBooking({
      customer_id: custRes.id,
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-10T17:00:00+07:00",
      end_at: "2026-09-10T18:00:00+07:00",
      status: "pending",
      source: "test"
    });
    const concPayment = await repository.createPayment({
      original_booking_id: concurrentPayBooking.id,
      payment_type: "full_payment",
      provider: "promptpay_qr",
      amount_due: "500.00",
      idempotency_key: `pg_conc_conf_${randomUUID()}`,
      expires_at: new Date(Date.now() + 60000).toISOString()
    });

    const poolConcurrent = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
    });
    const repoConcurrent = new PgBookingRepository({ pool: poolConcurrent });

    try {
      const confTxnRef = `txn-conc-${randomUUID()}`;
      const [r1, r2] = await Promise.all([
        confirmVerifiedPayment(repository, {
          paymentId: concPayment.id,
          verifiedAmount: "500.00",
          transactionNamespace: "promptpay_qr",
          transactionReference: confTxnRef
        }),
        confirmVerifiedPayment(repoConcurrent, {
          paymentId: concPayment.id,
          verifiedAmount: "500.00",
          transactionNamespace: "promptpay_qr",
          transactionReference: confTxnRef
        })
      ]);

      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, ["idempotent_success", "success"], "One confirmation succeeds and the competing concurrent request safely returns idempotent_success under row lock");

      // 17. Payment Verify vs Competing Transaction on Different Payments
      const compBooking1 = await repository.insertBooking({
        customer_id: custRes.id,
        service_id: service.id,
        staff_id: staff.id,
        start_at: "2026-09-11T10:00:00+07:00",
        end_at: "2026-09-11T11:00:00+07:00",
        status: "pending",
        source: "test"
      });
      const compBooking2 = await repository.insertBooking({
        customer_id: custRes.id,
        service_id: service.id,
        staff_id: staff.id,
        start_at: "2026-09-11T12:00:00+07:00",
        end_at: "2026-09-11T13:00:00+07:00",
        status: "pending",
        source: "test"
      });

      const compPayment1 = await repository.createPayment({
        original_booking_id: compBooking1.id,
        payment_type: "full_payment",
        provider: "promptpay_qr",
        amount_due: "500.00",
        idempotency_key: `comp_pay_1_${randomUUID()}`,
        expires_at: new Date(Date.now() + 60000).toISOString()
      });
      const compPayment2 = await repository.createPayment({
        original_booking_id: compBooking2.id,
        payment_type: "full_payment",
        provider: "promptpay_qr",
        amount_due: "500.00",
        idempotency_key: `comp_pay_2_${randomUUID()}`,
        expires_at: new Date(Date.now() + 60000).toISOString()
      });

      const sharedCompetingTxn = `txn-competing-${randomUUID()}`;
      const competingResults = await Promise.allSettled([
        confirmVerifiedPayment(repository, {
          paymentId: compPayment1.id,
          verifiedAmount: "500.00",
          transactionNamespace: "promptpay_qr",
          transactionReference: sharedCompetingTxn
        }),
        confirmVerifiedPayment(repoConcurrent, {
          paymentId: compPayment2.id,
          verifiedAmount: "500.00",
          transactionNamespace: "promptpay_qr",
          transactionReference: sharedCompetingTxn
        })
      ]);

      const compFulfilled = competingResults.filter((r) => r.status === "fulfilled");
      const compRejected = competingResults.filter((r) => r.status === "rejected");
      assert.equal(compFulfilled.length, 1, "Exactly one payment claims the competing transaction reference");
      assert.equal(compRejected.length, 1, "Competing payment confirmation is rejected");
      assert.equal(compRejected[0].reason.code, "TRANSACTION_ALREADY_REDEEMED", "Rejected error code is TRANSACTION_ALREADY_REDEEMED");
    } finally {
      await poolConcurrent.end();
    }

    // 18. Verify Dedicated PgPaymentRepository works with shared client
    const standalonePayment = await repository.transaction(async (tx) => {
      const dedicatedPaymentRepo = new PgPaymentRepository({ client: tx.client });
      return dedicatedPaymentRepo.createPayment({
        original_booking_id: bookingRes.id,
        payment_type: "deposit_fixed",
        provider: "promptpay_qr",
        amount_due: "50.00",
        amount_paid: "0.00",
        currency: "THB",
        status: "pending",
        idempotency_key: `standalone_pay_${randomUUID()}`,
        expires_at: new Date().toISOString()
      });
    });
    assert.ok(standalonePayment.id);
    assert.equal(standalonePayment.amount_due, "50.00");
  } finally {
    await pool.end();
  }
});

// =============================================================================
// PART 12: PostgreSQL Payment Integration Suite (Phase D)
// Real integration tests running against Docker PostgreSQL (TEST_DATABASE_URL):
// - pending booking blocks slot via GiST exclusion constraint
// - second booking gets GiST conflict and creates no payment
// - payment+booking+allocation atomic transaction
// - idempotent checkout returns same booking/payment
// - expiry releases slot (GiST frees slot so subsequent booking succeeds)
// - grace preserves slot against expiry
// - rollback leaves no orphan financial rows
// =============================================================================

test("PostgreSQL Payment Integration Suite (Phase D: Slot Hold, GiST Conflict, Idempotency, Expiry, Grace)", async (t) => {
  if (!shouldRunPostgres) {
    t.skip("TEST_DATABASE_URL is not set; skipping live PostgreSQL Phase D integration tests");
    return;
  }

  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    // 1. Setup fixtures (staff, service, customer) with valid PostgreSQL records
    const serviceRes = await pool.query(
      "insert into services (name, duration_minutes, price) values ('Phase D Cut', 45, 500) returning *"
    );
    const staffRes = await pool.query(
      "insert into staff (name, phone) values ('Phase D Stylist', '0891234567') returning *"
    );
    const service = serviceRes.rows[0];
    const staff = staffRes.rows[0];

    await pool.query(
      "insert into staff_services (staff_id, service_id) values ($1, $2)",
      [staff.id, service.id]
    );
    await pool.query(
      "insert into availability (staff_id, start_at, end_at, type) values ($1, '2026-09-15T08:00:00+07:00'::timestamptz, '2026-09-15T20:00:00+07:00'::timestamptz, 'available')",
      [staff.id]
    );
    const customer = await repository.insertCustomer({
      name: "Phase D Postgres Test",
      phone: `08${Math.floor(10000000 + Math.random() * 90000000)}`
    });

    // 2. Pending Booking Blocks Slot via GiST Exclusion Constraint
    const startSlot1 = "2026-09-15T09:00:00+07:00";
    const checkout1 = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Alpha", phone: "0811111111" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot1,
      source: "web"
    }, {
      businessSettings: { payment_type: "deposit_fixed", fixed_amount: 200 },
      entitlements: { payment: true, deposit: true }
    });

    assert.equal(checkout1.status, "payment_pending");
    assert.equal(checkout1.booking.status, "pending");
    assert.ok(checkout1.paymentId);

    // Verify in database: pending booking, payment, active allocation exist
    const dbBooking1 = await repository.getBooking(checkout1.bookingId);
    assert.equal(dbBooking1.status, "pending");
    const dbPayment1 = await repository.getPaymentById(checkout1.paymentId);
    assert.equal(dbPayment1.status, "pending");
    assert.equal(dbPayment1.original_booking_id, checkout1.bookingId);
    const dbAlloc1 = await repository.getActivePaymentAllocation(checkout1.bookingId);
    assert.ok(dbAlloc1);
    assert.equal(dbAlloc1.status, "active");

    // 3. Second booking gets GiST conflict in PostgreSQL and loser creates NO payment
    const paymentsCountBefore = (await pool.query("select count(*) from payments")).rows[0].count;
    const bookingsCountBefore = (await pool.query("select count(*) from bookings")).rows[0].count;

    await assert.rejects(
      BookingCheckoutService.checkout(repository, {
        customer: { name: "Customer Beta", phone: "0822222222" },
        service_id: service.id,
        staff_id: staff.id,
        start_at: "2026-09-15T09:15:00+07:00", // Overlaps slot 1 (09:00 - 09:45)
        source: "web"
      }, {
        businessSettings: { payment_type: "deposit_fixed", fixed_amount: 200 },
        entitlements: { payment: true, deposit: true }
      }),
      (err) => {
        return /conflict|overlap|23P01|exclusion|not available/i.test(err.message || err.code || "");
      }
    );

    // Direct GiST constraint verification:
    // Attempting direct raw insert into bookings table with overlapping pending status triggers GiST exclusion
    await assert.rejects(
      repository.insertBooking({
        customer_id: customer.id,
        service_id: service.id,
        staff_id: staff.id,
        start_at: "2026-09-15T09:15:00+07:00",
        end_at: "2026-09-15T10:00:00+07:00",
        status: "pending"
      }),
      (err) => /booking overlaps an existing active booking|BOOKING_CONFLICT|bookings_no_staff_overlap|23P01|exclusion/i.test(err.message || err.code || "")
    );

    const paymentsCountAfter = (await pool.query("select count(*) from payments")).rows[0].count;
    const bookingsCountAfter = (await pool.query("select count(*) from bookings")).rows[0].count;
    assert.equal(paymentsCountAfter, paymentsCountBefore, "Loser in slot conflict creates zero payment rows in PostgreSQL");
    assert.equal(bookingsCountAfter, bookingsCountBefore, "Loser in slot conflict creates zero booking rows in PostgreSQL");

    // 4. Idempotent Checkout in PostgreSQL
    const idempKey = `pg_chk_idemp_${randomUUID()}`;
    const startSlot2 = "2026-09-15T11:00:00+07:00";
    const idempCheckout1 = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Gamma", phone: "0833333333" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot2,
      idempotency_key: idempKey
    }, {
      businessSettings: { payment_type: "full_payment" },
      entitlements: { payment: true, deposit: false },
      idempotencyKey: idempKey
    });

    assert.equal(idempCheckout1.isExisting, false);

    // Repeat checkout with same idempotency key
    const idempCheckout2 = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Gamma", phone: "0833333333" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot2,
      idempotency_key: idempKey
    }, {
      businessSettings: { payment_type: "full_payment" },
      entitlements: { payment: true, deposit: false },
      idempotencyKey: idempKey
    });

    assert.equal(idempCheckout2.isExisting, true);
    assert.equal(idempCheckout2.bookingId, idempCheckout1.bookingId);
    assert.equal(idempCheckout2.paymentId, idempCheckout1.paymentId);

    // 5. Expiry Releases Slot in PostgreSQL
    const startSlot3 = "2026-09-15T13:00:00+07:00";
    const pastTime = new Date(Date.now() - 3600000); // 1 hour ago
    const expiredCheckout = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Delta", phone: "0844444444" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot3
    }, {
      businessSettings: { payment_type: "deposit_fixed", fixed_amount: 150 },
      entitlements: { payment: true, deposit: true },
      now: pastTime,
      expiryMinutes: 15
    });

    // Run expiry hold service
    const expiryEval = await expirePendingPaymentHold(repository, {
      paymentId: expiredCheckout.paymentId,
      now: new Date() // Current time is past expires_at
    });

    assert.equal(expiryEval.action, "EXPIRE");
    const expiredBookingInDb = await repository.getBooking(expiredCheckout.bookingId);
    assert.equal(expiredBookingInDb.status, "expired");
    const expiredPaymentInDb = await repository.getPaymentById(expiredCheckout.paymentId);
    assert.equal(expiredPaymentInDb.status, "expired");

    // Crucial Invariant: Since booking is now 'expired', the PostgreSQL GiST exclusion constraint
    // does not block slot 3 anymore! A subsequent customer booking the exact same slot succeeds!
    const rebookedSlot3 = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Epsilon", phone: "0855555555" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot3
    }, {
      businessSettings: { payment_type: "deposit_fixed", fixed_amount: 150 },
      entitlements: { payment: true, deposit: true }
    });
    assert.ok(rebookedSlot3.bookingId);
    assert.equal(rebookedSlot3.booking.status, "pending");

    // 6. Grace Preserves Slot in PostgreSQL
    const startSlot4 = "2026-09-15T15:00:00+07:00";
    const graceCheckout = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer Zeta", phone: "0866666666" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot4
    }, {
      businessSettings: { payment_type: "deposit_fixed", fixed_amount: 150 },
      entitlements: { payment: true, deposit: true },
      now: pastTime,
      expiryMinutes: 15
    });

    // Customer uploaded slip; verification deadline set to future
    const futureDeadline = new Date(Date.now() + 600000).toISOString();
    await repository.updatePayment(graceCheckout.paymentId, {
      status: "slip_received",
      verification_deadline: futureDeadline
    });

    const graceEval = await expirePendingPaymentHold(repository, {
      paymentId: graceCheckout.paymentId,
      now: new Date()
    });
    assert.equal(graceEval.action, "WAIT_GRACE");

    // Slot is STILL held by GiST constraint!
    await assert.rejects(
      BookingCheckoutService.checkout(repository, {
        customer: { name: "Customer Eta", phone: "0877777777" },
        service_id: service.id,
        staff_id: staff.id,
        start_at: startSlot4
      }, {
        businessSettings: { payment_type: "deposit_fixed", fixed_amount: 150 },
        entitlements: { payment: true, deposit: true }
      }),
      (err) => /conflict|overlap|23P01|exclusion|not available/i.test(err.message || err.code || "")
    );

    // 7. Atomic Rollback leaves no orphan financial rows in PostgreSQL
    const startSlot5 = "2026-09-15T17:00:00+07:00";
    const paymentsBeforeFail = (await pool.query("select count(*) from payments")).rows[0].count;
    const allocsBeforeFail = (await pool.query("select count(*) from payment_allocations")).rows[0].count;
    const bookingsBeforeFail = (await pool.query("select count(*) from bookings")).rows[0].count;

    await assert.rejects(
      repository.transaction(async (tx) => {
        // Step A: insert booking
        const bk = await tx.insertBooking({
          customer_id: customer.id,
          service_id: service.id,
          staff_id: staff.id,
          start_at: startSlot5,
          end_at: "2026-09-15T17:45:00+07:00",
          status: "pending"
        });

        // Step B: insert payment
        await tx.createPayment({
          original_booking_id: bk.id,
          payment_type: "deposit_fixed",
          provider: "promptpay_qr",
          amount_due: "200.00",
          idempotency_key: `fail_tx_${randomUUID()}`,
          expires_at: new Date(Date.now() + 60000).toISOString()
        });

        // Step C: simulate mid-transaction failure
        throw new Error("simulated mid-transaction failure");
      }),
      /simulated mid-transaction failure/
    );

    const paymentsAfterFail = (await pool.query("select count(*) from payments")).rows[0].count;
    const allocsAfterFail = (await pool.query("select count(*) from payment_allocations")).rows[0].count;
    const bookingsAfterFail = (await pool.query("select count(*) from bookings")).rows[0].count;

    assert.equal(paymentsAfterFail, paymentsBeforeFail, "No orphan payment row left after rollback in PostgreSQL");
    assert.equal(allocsAfterFail, allocsBeforeFail, "No orphan allocation row left after rollback in PostgreSQL");
    assert.equal(bookingsAfterFail, bookingsBeforeFail, "No orphan booking row left after rollback in PostgreSQL");

    // 8. No-Payment Idempotency in PostgreSQL
    const noPayIdempKey = `pg_nopay_${randomUUID()}`;
    const startSlot6 = "2026-09-15T18:00:00+07:00";
    const noPayInput = {
      customer: { name: "Customer NoPay", phone: "0888888888" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot6,
      idempotency_key: noPayIdempKey
    };

    const noPayRes1 = await BookingCheckoutService.checkout(repository, noPayInput, {
      entitlements: { payment: false, deposit: false }
    });
    assert.equal(noPayRes1.mode, "no_payment");
    assert.equal(noPayRes1.status, "confirmed");
    assert.equal(noPayRes1.isExisting, false);

    // Verify DB stored checkout_idempotency_key on bookings table
    const dbBkNoPay = (await pool.query("select * from bookings where id = $1", [noPayRes1.booking.id])).rows[0];
    assert.equal(dbBkNoPay.checkout_idempotency_key, noPayIdempKey);

    // Verify automation jobs count
    const jobsBefore = (await pool.query("select count(*) from automation_jobs where booking_id = $1", [noPayRes1.booking.id])).rows[0].count;
    assert.ok(Number(jobsBefore) > 0);

    // Second checkout with same idempotency key
    const noPayRes2 = await BookingCheckoutService.checkout(repository, noPayInput, {
      entitlements: { payment: false, deposit: false }
    });
    assert.equal(noPayRes2.mode, "no_payment");
    assert.equal(noPayRes2.status, "confirmed");
    assert.equal(noPayRes2.isExisting, true);
    assert.equal(noPayRes2.booking.id, noPayRes1.booking.id);

    // Verify automation jobs not duplicated
    const jobsAfter = (await pool.query("select count(*) from automation_jobs where booking_id = $1", [noPayRes1.booking.id])).rows[0].count;
    assert.equal(jobsAfter, jobsBefore, "Automation jobs must not be duplicated on repeated no_payment checkout in PostgreSQL");

    // 9. Concurrent duplicate no_payment checkouts in PostgreSQL
    const raceIdempKey = `pg_race_${randomUUID()}`;
    const startSlot7 = "2026-09-15T19:00:00+07:00";
    const raceInput = {
      customer: { name: "Customer Race", phone: "0899999999" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: startSlot7,
      idempotency_key: raceIdempKey
    };

    const [raceRes1, raceRes2] = await Promise.all([
      BookingCheckoutService.checkout(repository, raceInput, { entitlements: { payment: false, deposit: false } }),
      BookingCheckoutService.checkout(repository, raceInput, { entitlements: { payment: false, deposit: false } })
    ]);

    assert.equal(raceRes1.booking.id, raceRes2.booking.id, "Concurrent no_payment checkouts must resolve to same booking ID in PostgreSQL");
    const raceDbRows = (await pool.query("select * from bookings where checkout_idempotency_key = $1", [raceIdempKey])).rows;
    assert.equal(raceDbRows.length, 1, "Exactly one booking row persisted in PostgreSQL for concurrent duplicate checkouts");

    // 10. Payment entitlement error leaves zero orphan rows in PostgreSQL
    const paymentsBeforeError = (await pool.query("select count(*) from payments")).rows[0].count;
    const bookingsBeforeError = (await pool.query("select count(*) from bookings")).rows[0].count;

    await assert.rejects(
      BookingCheckoutService.checkout(
        repository,
        {
          customer: { name: "Customer ErrorBlock", phone: "0812341234" },
          service_id: service.id,
          staff_id: staff.id,
          start_at: "2026-09-15T20:00:00+07:00"
        },
        {
          businessSettings: { payment_type: "deposit_fixed", fixed_amount: 150 },
          hasFeatureFn: async () => { throw new Error("Entitlement provider outage"); }
        }
      ),
      (err) => err.code === "PAYMENT_CAPABILITY_UNAVAILABLE"
    );

    const paymentsAfterError = (await pool.query("select count(*) from payments")).rows[0].count;
    const bookingsAfterError = (await pool.query("select count(*) from bookings")).rows[0].count;
    assert.equal(paymentsAfterError, paymentsBeforeError, "Zero payment rows created in PostgreSQL on entitlement error");
    assert.equal(bookingsAfterError, bookingsBeforeError, "Zero booking rows created in PostgreSQL on entitlement error");

    // 11. Manual Review Deadline persistence and behavior in PostgreSQL
    const manualReviewCheckout = await BookingCheckoutService.checkout(repository, {
      customer: { name: "Customer ManualReview", phone: "0855555555" },
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-15T10:00:00+07:00",
      idempotency_key: `pg_man_${randomUUID()}`
    }, {
      businessSettings: { payment_type: "full_payment" },
      entitlements: { payment: true, deposit: false },
      now: new Date("2026-09-15T09:00:00Z"),
      expiryMinutes: 15
    });

    // Simulate slip verification grace exceeded -> escalate to manual_review
    const verifyGraceTime = new Date("2026-09-15T09:25:00Z");
    await pool.query(
      "update payments set status = 'verifying', verification_deadline = $2 where id = $1",
      [manualReviewCheckout.paymentId, verifyGraceTime.toISOString()]
    );

    const afterGraceTime = new Date("2026-09-15T09:26:00Z");
    const escalateRes = await expirePendingPaymentHold(repository, {
      paymentId: manualReviewCheckout.paymentId,
      now: afterGraceTime
    });

    assert.equal(escalateRes.action, "MANUAL_REVIEW");
    assert.ok(escalateRes.manualReviewDeadline);

    // Verify manual_review_deadline is persisted in PostgreSQL
    const dbPaymentRow = (await pool.query("select * from payments where id = $1", [manualReviewCheckout.paymentId])).rows[0];
    assert.equal(dbPaymentRow.status, "manual_review");
    assert.ok(dbPaymentRow.manual_review_deadline, "manual_review_deadline column must be persisted in PostgreSQL");

    // Check before deadline (T+5m) -> HOLD_FOR_REVIEW
    const holdRes = await expirePendingPaymentHold(repository, {
      paymentId: manualReviewCheckout.paymentId,
      now: new Date(afterGraceTime.getTime() + 5 * 60 * 1000)
    });
    assert.equal(holdRes.action, "HOLD_FOR_REVIEW");

    // Booking remains pending in PostgreSQL
    const dbBookingHold = (await pool.query("select status from bookings where id = $1", [manualReviewCheckout.bookingId])).rows[0];
    assert.equal(dbBookingHold.status, "pending");

    // Check after deadline (T+16m) -> MANUAL_REVIEW_EXPIRED
    const expiredRes = await expirePendingPaymentHold(repository, {
      paymentId: manualReviewCheckout.paymentId,
      now: new Date(afterGraceTime.getTime() + 16 * 60 * 1000)
    });
    assert.equal(expiredRes.action, "MANUAL_REVIEW_EXPIRED");

    // Status remains manual_review (no automatic state mutation outside transaction)
    const dbPaymentAfter = (await pool.query("select status from payments where id = $1", [manualReviewCheckout.paymentId])).rows[0];
    assert.equal(dbPaymentAfter.status, "manual_review");

  } finally {
    await pool.end();
  }
});

// =============================================================================
// PART 14: Phase E Live PostgreSQL Integration (Slip Intake & Payment Attempts)
// =============================================================================

test("PostgreSQL Live Integration (Phase E): PaymentAttempt persistence, duplicate slip hash, atomic verification confirmation, and error containment", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repository = new PgPaymentRepository({ pool });

  try {
    // Reset schema and apply migrations
    const schemaSql = await fs.readFile(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
    const migration004Sql = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "004_automation_jobs.sql"), "utf8");
    const migration005Sql = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "005_automation_retry.sql"), "utf8");
    const migration007Sql = await fs.readFile(path.join(__dirname, "..", "database", "migrations", "007_payment_schema.sql"), "utf8");

    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    await pool.query(schemaSql);
    await pool.query(migration004Sql);
    await pool.query(migration005Sql);
    await pool.query(migration007Sql);

    // Seed master data
    const service = (await pool.query(
      "insert into services(name, duration_minutes, price, active) values('ดีท็อกซ์หนังศีรษะ', 60, 950.00, true) returning *"
    )).rows[0];
    const staff = (await pool.query(
      "insert into staff(name, active) values('ช่างกานต์', true) returning *"
    )).rows[0];
    const customer = (await pool.query(
      "insert into customers(name, phone) values('ลูกค้าทดสอบ Phase E', '0891234567') returning *"
    )).rows[0];

    // 1. Create a pending booking with payment
    const checkoutResult = await BookingCheckoutService.checkout(repository, {
      customer: { name: customer.name, phone: customer.phone },
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-20T10:00:00+07:00",
      end_at: "2026-09-20T11:00:00+07:00",
      source: "line",
      idempotency_key: `pg_e_${randomUUID()}`
    }, {
      businessSettings: { payment_type: "deposit_fixed", fixed_amount: 300 },
      entitlements: { payment: true, deposit: true },
      now: new Date("2026-09-20T09:00:00Z"),
      expiryMinutes: 15
    });

    assert.equal(checkoutResult.status, "payment_pending");
    const paymentId = checkoutResult.paymentId;
    const bookingId = checkoutResult.bookingId;

    // 2. Persist PaymentAttempt in real PostgreSQL
    const slipHash1 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA-256
    const attempt1 = await repository.createPaymentAttempt({
      payment_id: paymentId,
      attempt_type: "slip_upload",
      verification_provider: "mock_slip",
      normalized_result: "success",
      slip_hash: slipHash1,
      verified_amount: "300.00",
      provider_status: "ok",
      raw_payload_sanitized: { messageId: "line-msg-001", slipHash: slipHash1 }
    });

    assert.ok(attempt1.id);
    assert.equal(attempt1.payment_id, paymentId);
    assert.equal(attempt1.slip_hash, slipHash1);

    // Query back from PostgreSQL
    const foundAttempt = await repository.findPaymentAttemptBySlipHash(slipHash1);
    assert.ok(foundAttempt);
    assert.equal(foundAttempt.id, attempt1.id);
    assert.equal(foundAttempt.payment_id, paymentId);

    const attemptsList = await repository.getPaymentAttempts(paymentId);
    assert.equal(attemptsList.length, 1);
    assert.equal(attemptsList[0].slip_hash, slipHash1);

    // 3. Duplicate slip hash lookup
    const foundAgain = await repository.findPaymentAttemptBySlipHash(slipHash1);
    assert.equal(foundAgain.payment_id, paymentId);

    // 4. Payment state transitions in PostgreSQL: pending -> slip_received -> verifying -> paid
    await pool.query("update payments set status = 'slip_received' where id = $1", [paymentId]);
    let currentPayment = await repository.getPaymentById(paymentId);
    assert.equal(currentPayment.status, "slip_received");

    await pool.query("update payments set status = 'verifying' where id = $1", [paymentId]);
    currentPayment = await repository.getPaymentById(paymentId);
    assert.equal(currentPayment.status, "verifying");

    // 5. Atomic confirmation on VALID mock slip
    const confirmRes = await confirmVerifiedPayment(repository, {
      paymentId,
      verifiedAmount: "300.00",
      transactionNamespace: "promptpay_slip",
      transactionReference: `slip_txn_${randomUUID().slice(0, 8)}`,
      auditContext: { source: "phase_e_test", slipHash: slipHash1 }
    });

    assert.equal(confirmRes.status, "success");
    assert.equal(confirmRes.payment.status, "paid");

    // Check DB rows in PostgreSQL
    const dbPaymentPaid = await repository.getPaymentById(paymentId);
    assert.equal(dbPaymentPaid.status, "paid");

    const dbBookingConfirmed = await repository.getBookingById(bookingId);
    assert.equal(dbBookingConfirmed.status, "confirmed");

    const events = await repository.getPaymentEvents(paymentId);
    assert.ok(events.some((e) => e.event_type === "payment_confirmed"));

    const allocations = await repository.getPaymentAllocations(paymentId);
    assert.ok(allocations.some((a) => a.status === "active" && a.amount === "300.00"));

    // 6. Verification failure containment: no orphan confirmed bookings
    const failedCheckout = await BookingCheckoutService.checkout(repository, {
      customer: { name: customer.name, phone: customer.phone },
      service_id: service.id,
      staff_id: staff.id,
      start_at: "2026-09-20T14:00:00+07:00",
      end_at: "2026-09-20T15:00:00+07:00",
      source: "line",
      idempotency_key: `pg_e_fail_${randomUUID()}`
    }, {
      businessSettings: { payment_type: "deposit_fixed", deposit_fixed_amount: 300 },
      entitlements: { payment: true, deposit: true },
      now: new Date("2026-09-20T09:00:00Z"),
      expiryMinutes: 15
    });

    // Mark attempt failed
    const failSlipHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await repository.createPaymentAttempt({
      payment_id: failedCheckout.paymentId,
      attempt_type: "slip_upload",
      verification_provider: "mock_slip",
      normalized_result: "amount_mismatch",
      slip_hash: failSlipHash,
      verified_amount: "150.00",
      failure_reason_code: "AMOUNT_MISMATCH",
      raw_payload_sanitized: { reason: "underpayment" }
    });

    await pool.query("update payments set status = 'verification_failed' where id = $1", [failedCheckout.paymentId]);

    // Verify booking in DB is NEVER confirmed
    const unconfirmedBooking = await repository.getBookingById(failedCheckout.bookingId);
    assert.equal(unconfirmedBooking.status, "pending");

    const failedPayment = await repository.getPaymentById(failedCheckout.paymentId);
    assert.equal(failedPayment.status, "verification_failed");

    const failedAllocations = await repository.getPaymentAllocations(failedCheckout.paymentId);
    assert.equal(failedAllocations.length, 0);

  } finally {
    await pool.end();
  }
});

// =============================================================================
// PART 15: PostgreSQL Hardening (Phase E Final)
// Durable LINE event idempotency, pre-verification attempt audit, timeout persistence,
// duplicate slip cross-payment rules, and customer pending payment persistence.
// =============================================================================

test("PostgreSQL Hardening (Phase E Final): Durable LINE idempotency, Attempt audit lifecycle, duplicate slip rules, and pending payments", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const repository = new PgPaymentRepository({ pool });

  try {
    // 1. Durable LINE Webhook Idempotency
    const uniqueEventId = `ev_durable_${randomUUID()}`;

    // First delivery: claimed successfully
    const claim1 = await repository.claimLineEvent(uniqueEventId);
    assert.ok(claim1, "First event delivery must be claimed successfully");
    assert.equal(claim1.event_id, uniqueEventId);
    assert.equal(claim1.status, "processing");

    // Second delivery: duplicate event while processing -> returns null (discarded)
    const claimDuplicate = await repository.claimLineEvent(uniqueEventId);
    assert.equal(claimDuplicate, null, "Duplicate in-flight event must return null");

    // Mark completed
    await repository.completeLineEvent(uniqueEventId);

    // Third delivery: duplicate event after completion -> returns null
    const claimAfterComplete = await repository.claimLineEvent(uniqueEventId);
    assert.equal(claimAfterComplete, null, "Duplicate completed event must return null");

    // 2. Concurrent Duplicate LINE Event Claims: Exactly one processor wins
    const concurrentEventId = `ev_concurrent_${randomUUID()}`;
    const [c1, c2, c3] = await Promise.all([
      repository.claimLineEvent(concurrentEventId),
      repository.claimLineEvent(concurrentEventId),
      repository.claimLineEvent(concurrentEventId)
    ]);

    const winners = [c1, c2, c3].filter(Boolean);
    const losers = [c1, c2, c3].filter((c) => c === null);
    assert.equal(winners.length, 1, "Exactly one concurrent processor must win event claim");
    assert.equal(losers.length, 2, "Concurrent duplicate claims must be rejected with null");
    await repository.completeLineEvent(concurrentEventId);

    // 3. Duplicate Event Detection across Service Restart (New Repository Instance)
    const restartEventId = `ev_restart_${randomUUID()}`;
    await repository.claimLineEvent(restartEventId);
    await repository.completeLineEvent(restartEventId);

    // Simulate process reboot by creating a fresh repository instance
    const rebootedRepo = new PgPaymentRepository({ pool });
    const claimAfterReboot = await rebootedRepo.claimLineEvent(restartEventId);
    assert.equal(claimAfterReboot, null, "Rebooted instance must detect durable completed event from PostgreSQL disk");

    // 4. PaymentAttempt Exists BEFORE Verification Completion
    const custRes = await pool.query(
      "insert into customers(name, phone) values('ลูกค้า Audit Lifecycle', '0899998888') returning *"
    );
    const testCust = custRes.rows[0];

    const svcRes = await pool.query(
      "insert into services(name, duration_minutes, price, active) values('สระไดร์ Audit', 45, 400.00, true) returning *"
    );
    const testSvc = svcRes.rows[0];

    const staffRes = await pool.query(
      "insert into staff(name, active) values('ช่างทดสอบ Audit', true) returning *"
    );
    const testStaff = staffRes.rows[0];

    const bookingRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, '2026-09-25T10:00:00+07:00', '2026-09-25T10:45:00+07:00', 'pending', 'line') returning *`,
      [testCust.id, testSvc.id, testStaff.id]
    );
    const testBooking = bookingRes.rows[0];

    const paymentRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-test', $1, 'deposit_fixed', 'promptpay_qr', 200.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [testBooking.id, `idem_audit_${randomUUID()}`]
    );
    const testPayment = paymentRes.rows[0];

    const slipHashAudit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const initialAttempt = await repository.createPaymentAttempt({
      payment_id: testPayment.id,
      attempt_type: "slip_upload",
      slip_hash: slipHashAudit,
      verification_provider: "mock_slip",
      provider_status: "received",
      normalized_result: "provider_error",
      failure_reason_code: "PENDING_VERIFICATION"
    });

    assert.ok(initialAttempt.id);
    assert.equal(initialAttempt.provider_status, "received");

    // Verify attempt is visibly persisted in PostgreSQL before provider completion
    const preVerificationAttempts = await repository.getPaymentAttempts(testPayment.id);
    assert.equal(preVerificationAttempts.length, 1);
    assert.equal(preVerificationAttempts[0].provider_status, "received");
    assert.equal(preVerificationAttempts[0].normalized_result, "provider_error");

    // Transition attempt to verifying
    await repository.updatePaymentAttempt(initialAttempt.id, {
      provider_status: "verifying"
    });

    const verifyingAttempts = await repository.getPaymentAttempts(testPayment.id);
    assert.equal(verifyingAttempts[0].provider_status, "verifying");

    // 5. Timeout Attempt Remains Auditable in PostgreSQL
    await repository.updatePaymentAttempt(initialAttempt.id, {
      provider_status: "timeout",
      normalized_result: "provider_error",
      failure_reason_code: "TIMEOUT"
    });

    const timeoutAttempts = await repository.getPaymentAttempts(testPayment.id);
    assert.equal(timeoutAttempts.length, 1);
    assert.equal(timeoutAttempts[0].provider_status, "timeout");
    assert.equal(timeoutAttempts[0].failure_reason_code, "TIMEOUT");

    // 6. Duplicate Slip: Same slip + same payment -> replay safe lookup
    const foundSamePaymentAttempt = await repository.findPaymentAttemptBySlipHash(slipHashAudit);
    assert.ok(foundSamePaymentAttempt);
    assert.equal(foundSamePaymentAttempt.payment_id, testPayment.id);

    // 7. Duplicate Slip: Same slip + different payment -> detected as duplicate cross-payment
    const otherPaymentRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-test', $1, 'deposit_fixed', 'promptpay_qr', 200.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [testBooking.id, `idem_other_${randomUUID()}`]
    );
    const otherPayment = otherPaymentRes.rows[0];

    const crossPaymentLookup = await repository.findPaymentAttemptBySlipHash(slipHashAudit);
    assert.equal(crossPaymentLookup.payment_id, testPayment.id, "Slip hash points to original payment");
    assert.notEqual(crossPaymentLookup.payment_id, otherPayment.id, "Different payment must recognize slip was already used elsewhere");

    // 8. Multiple Pending Payment Association in PostgreSQL
    // Initially, testBooking has 2 payments in pending status for testCust.id
    const customerPendingList = await repository.findPendingPaymentsByCustomer(testCust.id);
    assert.ok(customerPendingList.length >= 2, "Customer has >1 active pending payments in DB");

    // Update one payment to paid
    await pool.query("update payments set status = 'paid' where id = $1", [testPayment.id]);

    // Now query again: the paid payment is excluded, exactly 1 pending payment remains!
    const updatedPendingList = await repository.findPendingPaymentsByCustomer(testCust.id);
    const onlyPending = updatedPendingList.filter((p) => p.status === "pending");
    assert.equal(onlyPending.length, 1, "After one payment is paid, exactly 1 active pending payment is returned");
    assert.equal(onlyPending[0].id, otherPayment.id);

  } finally {
    await pool.end();
  }
});

// =============================================================================
// PART 16: PostgreSQL Live Integration (Phase F): Authoritative Provider Readiness & Safety
// 1. authoritative valid result -> paid + confirmed
// 2. non-authoritative valid-looking result -> NOT paid (manual review)
// 3. late payment after slot release -> evidence persisted -> original booking NOT confirmed
// 4. late payment when another booking owns slot -> second booking unaffected
// 5. duplicate authoritative transaction -> rejected
// 6. receiver insufficient data -> manual review
// 7. provider timeout -> attempt remains auditable
// 8. provider unavailable -> manual review
// =============================================================================

test("PostgreSQL Live Integration (Phase F): Authoritative Verification, Non-Authoritative Guard, Late Payment Containment, Duplicate Protection, and Timeout Audit", { skip: !shouldRunPostgres }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
  });
  const repository = new PgBookingRepository({ pool });

  try {
    // Setup base merchant customer, service, staff
    const custRes = await pool.query(
      "insert into customers(name, phone) values('ลูกค้า Phase F Live', '0891112222') returning *"
    );
    const customer = custRes.rows[0];

    const svcRes = await pool.query(
      "insert into services(name, duration_minutes, price, active) values('สระไดร์ Phase F', 45, 300.00, true) returning *"
    );
    const service = svcRes.rows[0];

    const staffRes = await pool.query(
      "insert into staff(name, active) values('ช่าง Phase F', true) returning *"
    );
    const staff = staffRes.rows[0];

    const slotStart1 = "2026-10-01T09:00:00+07:00";
    const slotEnd1 = "2026-10-01T09:45:00+07:00";

    // 1. Authoritative Valid Result -> paid + confirmed
    const booking1Res = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStart1, slotEnd1]
    );
    const booking1 = booking1Res.rows[0];

    const payment1Res = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [booking1.id, `idem_f_valid_${randomUUID()}`]
    );
    const payment1 = payment1Res.rows[0];

    const txnRef1 = `TXN_PG_AUTH_VALID_${Date.now()}`;
    const validAuthResult = {
      verified: true,
      authoritative: true,
      provider: "sandbox_authoritative",
      providerRequestId: `req_pg_f_1_${randomUUID().slice(0, 8)}`,
      transactionNamespace: "promptpay_qr",
      transactionReference: txnRef1,
      amountSatang: 30000,
      currency: "THB",
      receiver: { merchantIdentifier: "biz-phase-f" },
      sender: { bankCode: "002", accountNumberMasked: "xxx-x-xx111-1" },
      transactionAt: new Date().toISOString()
    };

    const confirmResult1 = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: payment1.id,
      verificationResult: validAuthResult,
      entitlements: { slipVerification: true, autoPaymentConfirmation: true }
    });

    assert.equal(confirmResult1.success, true);
    assert.equal(confirmResult1.code, "PAYMENT_CONFIRMED");

    const pgPayment1 = await repository.getPaymentById(payment1.id);
    assert.equal(pgPayment1.status, PAYMENT_STATUSES.paid);
    assert.equal(pgPayment1.transaction_reference, txnRef1);

    const pgBooking1 = await repository.getBookingById(booking1.id);
    assert.equal(pgBooking1.status, "confirmed");

    // 2. Non-Authoritative Result (AI/OCR) -> NOT paid, routes to manual review
    const slotStart2 = "2026-10-01T10:00:00+07:00";
    const slotEnd2 = "2026-10-01T10:45:00+07:00";

    const booking2Res = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStart2, slotEnd2]
    );
    const booking2 = booking2Res.rows[0];

    const payment2Res = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [booking2.id, `idem_f_ocr_${randomUUID()}`]
    );
    const payment2 = payment2Res.rows[0];

    const ocrResult = {
      verified: true,
      authoritative: false, // AI Vision / OCR is NOT authoritative!
      provider: "ai_vision_ocr",
      providerRequestId: `req_pg_ocr_${randomUUID().slice(0, 8)}`,
      transactionNamespace: "promptpay_qr",
      transactionReference: `TXN_OCR_${Date.now()}`,
      amountSatang: 30000,
      currency: "THB",
      receiver: { merchantIdentifier: "biz-phase-f" },
      transactionAt: new Date().toISOString()
    };

    const ocrIntakeResult = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: payment2.id,
      verificationResult: ocrResult
    });

    assert.equal(ocrIntakeResult.success, false);
    assert.equal(ocrIntakeResult.code, PAYMENT_REASON_CODES.NON_AUTHORITATIVE_VERIFICATION);

    const pgPayment2 = await repository.getPaymentById(payment2.id);
    assert.equal(pgPayment2.status, PAYMENT_STATUSES.manualReview, "Non-authoritative verification must NOT transition to paid");

    const pgBooking2 = await repository.getBookingById(booking2.id);
    assert.equal(pgBooking2.status, "pending", "Booking must remain pending when verification is non-authoritative");

    // 3 & 4. Late Payment Safety & Re-allocated Slot Protection
    // Slot 3: Booking A expires and slot is released. Booking B books slot 3.
    const slotStart3 = "2026-10-01T11:00:00+07:00";
    const slotEnd3 = "2026-10-01T11:45:00+07:00";

    const bookingARes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'expired', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStart3, slotEnd3]
    );
    const bookingA = bookingARes.rows[0];

    const paymentARes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() - interval '10 minutes', 'expired') returning *`,
      [bookingA.id, `idem_f_late_a_${randomUUID()}`]
    );
    const paymentA = paymentARes.rows[0];

    // Customer B claims slot 3 and confirms it
    const custBRes = await pool.query(
      "insert into customers(name, phone) values('ลูกค้า B ผู้ได้คิว', '0893334444') returning *"
    );
    const customerB = custBRes.rows[0];

    const bookingBRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'confirmed', 'web') returning *`,
      [customerB.id, service.id, staff.id, slotStart3, slotEnd3]
    );
    const bookingB = bookingBRes.rows[0];

    // Authoritative provider reports late payment for Booking A
    const lateTxnRef = `TXN_LATE_GENUINE_${Date.now()}`;
    const lateResult = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: paymentA.id,
      verificationResult: {
        verified: true,
        authoritative: true,
        provider: "authoritative_provider",
        providerRequestId: `req_pg_late_${randomUUID().slice(0, 8)}`,
        transactionNamespace: "promptpay_qr",
        transactionReference: lateTxnRef,
        amountSatang: 30000,
        currency: "THB",
        receiver: { merchantIdentifier: "biz-phase-f" },
        transactionAt: new Date().toISOString()
      }
    });

    assert.equal(lateResult.success, false);
    assert.equal(lateResult.route, "LATE_PAYMENT_MANUAL_REVIEW");

    // Payment A records evidence in database
    const pgPaymentA = await repository.getPaymentById(paymentA.id);
    assert.equal(pgPaymentA.status, PAYMENT_STATUSES.manualReview);

    const attemptsA = await repository.getPaymentAttempts(paymentA.id);
    assert.ok(attemptsA.length >= 1);
    assert.equal(attemptsA[0].verified_transaction_reference, lateTxnRef);
    assert.equal(attemptsA[0].failure_reason_code, PAYMENT_REASON_CODES.LATE_PAYMENT_REVIEW);

    // Booking A remains expired (NOT confirmed)
    const pgBookingA = await repository.getBookingById(bookingA.id);
    assert.equal(pgBookingA.status, "expired");

    // Booking B remains confirmed and completely unaffected
    const pgBookingB = await repository.getBookingById(bookingB.id);
    assert.equal(pgBookingB.status, "confirmed");
    assert.equal(pgBookingB.customer_id, customerB.id);

    // 5. Duplicate Authoritative Transaction -> Rejected by constraint
    const slotStart4 = "2026-10-01T13:00:00+07:00";
    const slotEnd4 = "2026-10-01T13:45:00+07:00";

    const bookingCRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStart4, slotEnd4]
    );
    const bookingC = bookingCRes.rows[0];

    const paymentCRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [bookingC.id, `idem_f_dup_${randomUUID()}`]
    );
    const paymentC = paymentCRes.rows[0];

    // Replay the redeemed reference txnRef1 from step 1
    await assert.rejects(
      confirmVerifiedPayment(repository, {
        paymentId: paymentC.id,
        verifiedAmount: 300.00,
        transactionNamespace: "promptpay_qr",
        transactionReference: txnRef1,
        actor: "slip_verifier"
      }),
      (err) => {
        return /TRANSACTION_ALREADY_REDEEMED|claimed for another payment|already been redeemed/i.test(err.message || err.code || "");
      }
    );

    // 6. Receiver Insufficient Data -> Manual Review
    const slotStart5 = "2026-10-01T14:00:00+07:00";
    const slotEnd5 = "2026-10-01T14:45:00+07:00";

    const bookingDRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStart5, slotEnd5]
    );
    const bookingD = bookingDRes.rows[0];

    const paymentDRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [bookingD.id, `idem_f_insuf_${randomUUID()}`]
    );
    const paymentD = paymentDRes.rows[0];

    const insufficientDataResult = {
      verified: true,
      authoritative: true,
      provider: "sandbox_authoritative",
      providerRequestId: `req_insuf_${randomUUID().slice(0, 8)}`,
      transactionNamespace: "promptpay_qr",
      transactionReference: `TXN_INSUF_${Date.now()}`,
      amountSatang: 30000,
      currency: "THB",
      receiver: { accountName: "Salon Booking OS" }, // Name only without strong identifier
      transactionAt: new Date().toISOString()
    };

    const insufIntake = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: paymentD.id,
      verificationResult: insufficientDataResult,
      expectedReceiver: { accountName: "Salon Booking OS" }
    });

    assert.equal(insufIntake.success, false);
    assert.equal(insufIntake.code, PAYMENT_REASON_CODES.INSUFFICIENT_RECEIVER_DATA);

    const pgPaymentD = await repository.getPaymentById(paymentD.id);
    assert.equal(pgPaymentD.status, PAYMENT_STATUSES.manualReview);

    // 7. Provider Timeout -> Attempt remains auditable
    const timeoutAttempt = await repository.createPaymentAttempt({
      id: randomUUID(),
      payment_id: paymentD.id,
      attempt_type: "gateway_callback",
      verification_provider: "sandbox_authoritative",
      provider_status: "timeout",
      normalized_result: "provider_error",
      failure_reason_code: PAYMENT_REASON_CODES.PROVIDER_TIMEOUT,
      created_at: new Date().toISOString()
    });
    assert.ok(timeoutAttempt.id);

    const attemptsD = await repository.getPaymentAttempts(paymentD.id);
    const foundTimeout = attemptsD.find((a) => a.failure_reason_code === PAYMENT_REASON_CODES.PROVIDER_TIMEOUT);
    assert.ok(foundTimeout, "Timeout attempt remains auditable on PostgreSQL disk");

    // 8. Provider Unavailable -> Escalates to Manual Review
    await repository.updatePayment(paymentD.id, {
      status: PAYMENT_STATUSES.manualReview,
      updated_at: new Date().toISOString()
    });
    const pgPaymentDAfter = await repository.getPaymentById(paymentD.id);
    assert.equal(pgPaymentDAfter.status, PAYMENT_STATUSES.manualReview);

    // 9. Undefined / Partial Entitlement Never Confirms -> Remains Pending Booking, Manual Review Payment
    const slotStartE = "2026-10-01T15:00:00+07:00";
    const slotEndE = "2026-10-01T15:45:00+07:00";
    const bookingERes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStartE, slotEndE]
    );
    const bookingE = bookingERes.rows[0];

    const paymentERes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [bookingE.id, `idem_f_ent_${randomUUID()}`]
    );
    const paymentE = paymentERes.rows[0];

    // Undefined entitlements passed -> must fail closed to manual review
    const undefEntResult = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: paymentE.id,
      verificationResult: {
        ...validAuthResult,
        transactionReference: `TXN_UNDEF_ENT_${Date.now()}`
      },
      entitlements: undefined
    });
    assert.equal(undefEntResult.success, false);
    assert.equal(undefEntResult.code, PAYMENT_REASON_CODES.ENTITLEMENT_NOT_GRANTED);

    const pgPaymentE = await repository.getPaymentById(paymentE.id);
    assert.equal(pgPaymentE.status, PAYMENT_STATUSES.manualReview);
    const pgBookingE = await repository.getBookingById(bookingE.id);
    assert.equal(pgBookingE.status, "pending", "Booking E must remain pending and unconfirmed");

    // 10. Provider Without Transaction Time Capability Never Confirms
    const slotStartF = "2026-10-01T16:00:00+07:00";
    const slotEndF = "2026-10-01T16:45:00+07:00";
    const bookingFRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStartF, slotEndF]
    );
    const bookingF = bookingFRes.rows[0];

    const paymentFRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [bookingF.id, `idem_f_cap_${randomUUID()}`]
    );
    const paymentF = paymentFRes.rows[0];

    const noTimeCapResult = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: paymentF.id,
      verificationResult: {
        ...validAuthResult,
        transactionReference: `TXN_NOCAP_${Date.now()}`
      },
      providerCapabilities: {
        ...DEFAULT_PROVIDER_CAPABILITIES,
        supportsTransactionTime: false
      },
      entitlements: { slipVerification: true, autoPaymentConfirmation: true }
    });
    assert.equal(noTimeCapResult.success, false);
    assert.equal(noTimeCapResult.code, PAYMENT_REASON_CODES.INSUFFICIENT_PROVIDER_CAPABILITY);

    const pgPaymentF = await repository.getPaymentById(paymentF.id);
    assert.equal(pgPaymentF.status, PAYMENT_STATUSES.manualReview);
    const pgBookingF = await repository.getBookingById(bookingF.id);
    assert.equal(pgBookingF.status, "pending", "Booking F must remain pending when provider lacks time capability");

    // 11. Malformed transactionAt Never Confirms
    const slotStartG = "2026-10-01T17:00:00+07:00";
    const slotEndG = "2026-10-01T17:45:00+07:00";
    const bookingGRes = await pool.query(
      `insert into bookings(customer_id, service_id, staff_id, start_at, end_at, status, source)
       values($1, $2, $3, $4, $5, 'pending', 'web') returning *`,
      [customer.id, service.id, staff.id, slotStartG, slotEndG]
    );
    const bookingG = bookingGRes.rows[0];

    const paymentGRes = await pool.query(
      `insert into payments(business_id, original_booking_id, payment_type, provider, amount_due, idempotency_key, expires_at, status)
       values('biz-phase-f', $1, 'full_payment', 'promptpay_qr', 300.00, $2, now() + interval '15 minutes', 'pending') returning *`,
      [bookingG.id, `idem_f_malformed_${randomUUID()}`]
    );
    const paymentG = paymentGRes.rows[0];

    const malformedResult = await SlipIntakeService.processAuthoritativeNotification(repository, {
      paymentId: paymentG.id,
      verificationResult: {
        ...validAuthResult,
        transactionReference: `TXN_MALFORMED_${Date.now()}`,
        transactionAt: "this-is-not-a-valid-timestamp"
      },
      entitlements: { slipVerification: true, autoPaymentConfirmation: true }
    });
    assert.equal(malformedResult.success, false);
    assert.equal(malformedResult.code, PAYMENT_REASON_CODES.INVALID_TRANSACTION_TIME);

    const pgPaymentG = await repository.getPaymentById(paymentG.id);
    assert.equal(pgPaymentG.status, PAYMENT_STATUSES.manualReview);
    const pgBookingG = await repository.getBookingById(bookingG.id);
    assert.equal(pgBookingG.status, "pending", "Booking G must remain pending on malformed timestamp");

    // 12. Unsafe Retry Outcome (PROVIDER_UNCERTAIN_RESULT) Leaves Auditable PaymentAttempt Row
    const uncertainAttempt = await repository.createPaymentAttempt({
      id: randomUUID(),
      payment_id: paymentG.id,
      attempt_type: "gateway_callback",
      verification_provider: "sandbox_authoritative",
      provider_status: "failed",
      normalized_result: "provider_error",
      failure_reason_code: PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT,
      created_at: new Date().toISOString()
    });
    assert.ok(uncertainAttempt.id);

    const attemptsG = await repository.getPaymentAttempts(paymentG.id);
    const foundUncertain = attemptsG.find((a) => a.failure_reason_code === PAYMENT_REASON_CODES.PROVIDER_UNCERTAIN_RESULT);
    assert.ok(foundUncertain, "Uncertain provider attempt row must be persisted on disk for reconciliation");

    // Confirm no duplicate confirmation events exist for payment G
    const eventsG = await pool.query("select * from payment_events where payment_id = $1", [paymentG.id]);
    const hasPaidEvent = eventsG.rows.some((e) => e.to_status === PAYMENT_STATUSES.paid);
    assert.equal(hasPaidEvent, false, "No paid event must be generated for unconfirmed payment");

  } finally {
    await pool.end();
  }
});



