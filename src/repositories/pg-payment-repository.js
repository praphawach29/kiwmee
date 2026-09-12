// Salon Booking OS v1 - PostgreSQL Payment Repository
// Dedicated repository for payments, allocations, attempts, events, and refunds
// Supports shared client/transaction scope with PgBookingRepository

const { randomUUID } = require("node:crypto");
const { encodeMoneyForDb } = require("../payment/money");
const { sanitizePaymentAttempt } = require("../payment/data-safety");

let Pool;

class PgPaymentRepository {
  constructor(options = {}) {
    if (!Pool) {
      ({ Pool } = require("pg"));
    }

    this.pool = options.pool ?? (options.client ? null : new Pool({
      connectionString: options.connectionString ?? getDatabaseUrl(),
      ssl: readSslConfig(options)
    }));
    this.client = options.client ?? null;
  }

  async close() {
    if (!this.client && this.pool) {
      await this.pool.end();
    }
  }

  async transaction(callback) {
    if (this.client) {
      // Re-use existing transaction client without spawning a new one
      return callback(this);
    }
    const client = await this.pool.connect();
    const tx = new this.constructor({ pool: this.pool, client });

    try {
      await client.query("begin");
      const result = await callback(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw normalizePgError(error);
    } finally {
      client.release();
    }
  }

  async query(text, params = []) {
    const runner = this.client ?? this.pool;
    try {
      const result = await runner.query(text, params);
      return result.rows;
    } catch (error) {
      throw normalizePgError(error);
    }
  }

  // ===========================================================================
  // Payment Methods
  // Lock Ordering Hierarchy:
  // 1. payment row (SELECT ... FROM payments WHERE id = $1 FOR UPDATE)
  // 2. booking row (SELECT ... FROM bookings WHERE id = $1 FOR UPDATE)
  // 3. allocation rows (SELECT ... FROM payment_allocations WHERE payment_id = $1 FOR UPDATE)
  // 4. refund rows (SELECT ... FROM refunds WHERE id = $1 FOR UPDATE)
  // ===========================================================================

  async createPayment(payment) {
    const id = payment.id ?? randomUUID();
    const amountDue = encodeMoneyForDb(payment.amount_due ?? 0);
    const amountPaid = encodeMoneyForDb(payment.amount_paid ?? 0);
    const nowIso = new Date().toISOString();

    const rows = await this.query(
      `
        insert into payments (
          id,
          business_id,
          original_booking_id,
          payment_type,
          provider,
          amount_due,
          amount_paid,
          currency,
          status,
          provider_reference,
          transaction_namespace,
          transaction_reference,
          idempotency_key,
          expires_at,
          verification_deadline,
          manual_review_deadline,
          paid_at,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        returning *
      `,
      [
        id,
        payment.business_id ?? "default",
        payment.original_booking_id,
        payment.payment_type,
        payment.provider,
        amountDue,
        amountPaid,
        payment.currency ?? "THB",
        payment.status ?? "pending",
        payment.provider_reference ?? null,
        payment.transaction_namespace ?? payment.provider,
        payment.transaction_reference ?? null,
        payment.idempotency_key,
        payment.expires_at,
        payment.verification_deadline ?? null,
        payment.manual_review_deadline ?? null,
        payment.paid_at ?? null,
        payment.created_at ?? nowIso,
        payment.updated_at ?? nowIso
      ]
    );
    return rows[0];
  }

  async insertPayment(payment) {
    return this.createPayment(payment);
  }

  async getPaymentById(paymentId) {
    const rows = await this.query("select * from payments where id = $1", [paymentId]);
    return rows[0] ?? null;
  }

  async getPaymentByIdForUpdate(paymentId) {
    if (!this.client) {
      throw new Error("getPaymentByIdForUpdate must be called inside a transaction");
    }
    const rows = await this.query("select * from payments where id = $1 for update", [paymentId]);
    return rows[0] ?? null;
  }

  async getPaymentForUpdate(paymentId) {
    return this.getPaymentByIdForUpdate(paymentId);
  }

  async findPaymentByIdempotencyKey(key) {
    const rows = await this.query("select * from payments where idempotency_key = $1", [key]);
    return rows[0] ?? null;
  }

  async findPaymentByTransactionReference(namespace, reference) {
    const rows = await this.query(
      "select * from payments where transaction_namespace = $1 and transaction_reference = $2",
      [namespace, reference]
    );
    return rows[0] ?? null;
  }

  async findPaymentByTransaction(namespace, reference) {
    return this.findPaymentByTransactionReference(namespace, reference);
  }

  async getPaymentsByBookingId(bookingId) {
    return this.query("select * from payments where original_booking_id = $1 order by created_at desc", [bookingId]);
  }

  async findPaymentByBookingId(bookingId) {
    const rows = await this.getPaymentsByBookingId(bookingId);
    return rows[0] ?? null;
  }

  async findPendingPaymentsByCustomer(customerId, statuses = ["pending", "slip_received", "verifying", "payment_failed", "payment_manual_review"]) {
    return this.query(
      `
        select p.*
        from payments p
        join bookings b on p.original_booking_id = b.id
        where b.customer_id = $1
          and p.status = any($2::text[])
          and b.status in ('pending', 'confirmed')
        order by p.created_at desc
      `,
      [customerId, statuses]
    );
  }

  async updatePayment(paymentId, patch) {
    const fields = [];
    const values = [];
    let idx = 1;

    const allowed = [
      "status", "amount_paid", "paid_at", "transaction_namespace",
      "transaction_reference", "provider_reference", "verification_deadline",
      "manual_review_deadline", "expires_at", "amount_due"
    ];

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        let val = patch[key];
        if (key === "amount_paid" || key === "amount_due") {
          val = encodeMoneyForDb(val);
        }
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    if (patch.updated_at !== undefined) {
      fields.push(`updated_at = $${idx++}`);
      values.push(patch.updated_at);
    } else {
      fields.push(`updated_at = now()`);
    }

    if (fields.length === 0) {
      return this.getPaymentById(paymentId);
    }

    values.push(paymentId);
    const sql = `update payments set ${fields.join(", ")} where id = $${idx} returning *`;
    const rows = await this.query(sql, values);
    return rows[0] ?? null;
  }

  async createPaymentEvent(event) {
    const id = event.id ?? randomUUID();
    const rows = await this.query(
      `
        insert into payment_events (
          id, payment_id, event_type, from_status, to_status,
          actor, reason_code, metadata, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        returning *
      `,
      [
        id,
        event.payment_id,
        event.event_type,
        event.from_status ?? null,
        event.to_status,
        event.actor ?? "system",
        event.reason_code ?? null,
        JSON.stringify(event.metadata ?? {}),
        event.created_at ?? new Date().toISOString()
      ]
    );
    return rows[0];
  }

  async insertPaymentEvent(event) {
    return this.createPaymentEvent(event);
  }

  async getPaymentEvents(paymentId) {
    return this.query(
      "select * from payment_events where payment_id = $1 order by created_at asc",
      [paymentId]
    );
  }

  async createPaymentAllocation(allocation) {
    const id = allocation.id ?? randomUUID();
    const amount = encodeMoneyForDb(allocation.amount);
    const rows = await this.query(
      `
        insert into payment_allocations (
          id, payment_id, booking_id, amount, allocation_type,
          status, created_at, released_at, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        returning *
      `,
      [
        id,
        allocation.payment_id,
        allocation.booking_id,
        amount,
        allocation.allocation_type ?? "initial",
        allocation.status ?? "active",
        allocation.created_at ?? new Date().toISOString(),
        allocation.released_at ?? null,
        JSON.stringify(allocation.metadata ?? {})
      ]
    );
    return rows[0];
  }

  async insertPaymentAllocation(allocation) {
    return this.createPaymentAllocation(allocation);
  }

  async getActivePaymentAllocation(bookingId, paymentId = null) {
    const rows = await this.query(
      `
        select * from payment_allocations
        where booking_id = $1 and status = 'active'
          and ($2::uuid is null or payment_id = $2::uuid)
        order by created_at desc
        limit 1
      `,
      [bookingId, paymentId]
    );
    return rows[0] ?? null;
  }

  async getPaymentAllocations(paymentId) {
    return this.query(
      "select * from payment_allocations where payment_id = $1 order by created_at",
      [paymentId]
    );
  }

  async updatePaymentAllocation(id, patch) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (patch.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(patch.status);
    }
    if (patch.released_at !== undefined) {
      fields.push(`released_at = $${idx++}`);
      values.push(patch.released_at);
    }
    if (patch.metadata !== undefined) {
      fields.push(`metadata = $${idx++}::jsonb`);
      values.push(JSON.stringify(patch.metadata));
    }

    if (fields.length === 0) {
      const rows = await this.query("select * from payment_allocations where id = $1", [id]);
      return rows[0] ?? null;
    }

    values.push(id);
    const sql = `update payment_allocations set ${fields.join(", ")} where id = $${idx} returning *`;
    const rows = await this.query(sql, values);
    return rows[0] ?? null;
  }

  async createRefund(refund) {
    const id = refund.id ?? randomUUID();
    const amount = encodeMoneyForDb(refund.amount);
    const nowIso = new Date().toISOString();

    const rows = await this.query(
      `
        insert into refunds (
          id, payment_id, booking_id, amount, reason,
          status, idempotency_key, provider, provider_refund_id,
          approved_by, completed_at, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        returning *
      `,
      [
        id,
        refund.payment_id,
        refund.booking_id,
        amount,
        refund.reason,
        refund.status ?? "pending",
        refund.idempotency_key,
        refund.provider ?? null,
        refund.provider_refund_id ?? null,
        refund.approved_by,
        refund.completed_at ?? null,
        refund.created_at ?? nowIso,
        refund.updated_at ?? nowIso
      ]
    );
    return rows[0];
  }

  async insertRefund(refund) {
    return this.createRefund(refund);
  }

  async getRefundsByPayment(paymentId) {
    return this.query(
      "select * from refunds where payment_id = $1 order by created_at",
      [paymentId]
    );
  }

  async getRefundsForPayment(paymentId) {
    return this.getRefundsByPayment(paymentId);
  }

  async findRefundByIdempotencyKey(key) {
    const rows = await this.query("select * from refunds where idempotency_key = $1", [key]);
    return rows[0] ?? null;
  }

  async getRefundForUpdate(refundId) {
    if (!this.client) {
      throw new Error("getRefundForUpdate must be called inside a transaction");
    }
    const rows = await this.query("select * from refunds where id = $1 for update", [refundId]);
    return rows[0] ?? null;
  }

  async updateRefund(refundId, patch) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (patch.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(patch.status);
    }
    if (patch.provider_refund_id !== undefined) {
      fields.push(`provider_refund_id = $${idx++}`);
      values.push(patch.provider_refund_id);
    }
    if (patch.completed_at !== undefined) {
      fields.push(`completed_at = $${idx++}`);
      values.push(patch.completed_at);
    }
    if (patch.updated_at !== undefined) {
      fields.push(`updated_at = $${idx++}`);
      values.push(patch.updated_at);
    } else {
      fields.push(`updated_at = now()`);
    }

    if (fields.length === 0) {
      const rows = await this.query("select * from refunds where id = $1", [refundId]);
      return rows[0] ?? null;
    }

    values.push(refundId);
    const sql = `update refunds set ${fields.join(", ")} where id = $${idx} returning *`;
    const rows = await this.query(sql, values);
    return rows[0] ?? null;
  }

  async listBookingsForStaff(staffId, start, end, statuses = ["pending", "confirmed"], excludeBookingId = null) {
    return this.query(
      `
        select *
        from bookings
        where staff_id = $1
          and status = any($4::text[])
          and start_at < $3
          and end_at > $2
          and ($5::uuid is null or id <> $5::uuid)
        order by start_at, end_at
      `,
      [staffId, start, end, statuses, excludeBookingId]
    );
  }

  async findConflictingActiveBooking(staffId, start, end, excludeBookingId = null) {
    const rows = await this.listBookingsForStaff(staffId, start, end, ["pending", "confirmed"], excludeBookingId);
    return rows[0] || null;
  }

  async createPaymentAttempt(attempt) {
    const clean = sanitizePaymentAttempt(attempt);
    const id = clean.id ?? randomUUID();
    const verifiedAmount = clean.verified_amount !== undefined && clean.verified_amount !== null
      ? encodeMoneyForDb(clean.verified_amount)
      : null;

    const rows = await this.query(
      `
        insert into payment_attempts (
          id, payment_id, attempt_type, slip_object_reference, slip_hash,
          verification_provider, provider_request_id, provider_status,
          normalized_result, verified_amount, verified_receiver, verified_sender,
          verified_transaction_reference, verified_transaction_at,
          failure_reason_code, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        returning *
      `,
      [
        id,
        clean.payment_id,
        clean.attempt_type,
        clean.slip_object_reference ?? null,
        clean.slip_hash ?? null,
        clean.verification_provider,
        clean.provider_request_id ?? null,
        clean.provider_status ?? null,
        clean.normalized_result,
        verifiedAmount,
        clean.verified_receiver ?? null,
        clean.verified_sender ?? null,
        clean.verified_transaction_reference ?? null,
        clean.verified_transaction_at ?? null,
        clean.failure_reason_code ?? null,
        clean.created_at ?? new Date().toISOString()
      ]
    );
    return rows[0];
  }

  async insertPaymentAttempt(attempt) {
    return this.createPaymentAttempt(attempt);
  }

  async updatePaymentAttempt(id, patch) {
    const fields = [];
    const values = [];
    let idx = 1;

    const allowed = [
      "provider_status", "normalized_result", "verified_amount",
      "verified_receiver", "verified_sender", "verified_transaction_reference",
      "verified_transaction_at", "failure_reason_code", "provider_request_id",
      "slip_hash", "verification_provider"
    ];

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        let val = patch[key];
        if (key === "verified_amount" && val !== null) {
          val = encodeMoneyForDb(val);
        }
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    if (fields.length === 0) {
      const rows = await this.query("select * from payment_attempts where id = $1", [id]);
      return rows[0] ?? null;
    }

    values.push(id);
    const sql = `update payment_attempts set ${fields.join(", ")} where id = $${idx} returning *`;
    const rows = await this.query(sql, values);
    return rows[0] ?? null;
  }

  async findPaymentAttemptBySlipHash(slipHash) {
    if (!slipHash) return null;
    const rows = await this.query(
      "select * from payment_attempts where slip_hash = $1 order by created_at desc limit 1",
      [slipHash]
    );
    return rows[0] ?? null;
  }

  async getPaymentAttempts(paymentId) {
    return this.query(
      "select * from payment_attempts where payment_id = $1 order by created_at asc",
      [paymentId]
    );
  }

  async getPaymentAttemptsByPaymentId(paymentId) {
    return this.getPaymentAttempts(paymentId);
  }

  async claimLineEvent(id) {
    const rows = await this.query(
      `
        insert into line_webhook_events (event_id, status, attempts)
        values ($1, 'processing', 1)
        on conflict (event_id) do update
          set status = 'processing',
              attempts = line_webhook_events.attempts + 1,
              last_error = null,
              updated_at = now()
        where line_webhook_events.status = 'failed'
        returning *
      `,
      [id]
    );
    return rows[0] ?? null;
  }

  async completeLineEvent(id) {
    await this.query(
      "update line_webhook_events set status = 'completed', updated_at = now() where event_id = $1",
      [id]
    );
    return true;
  }

  async failLineEvent(id, errorMsg = "webhook processing failed") {
    await this.query(
      "update line_webhook_events set status = 'failed', last_error = $2, updated_at = now() where event_id = $1",
      [id, errorMsg]
    );
    return true;
  }
}

function getDatabaseUrl(env = process.env) {
  const url = env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? env.POSTGRES_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for server database access");
  }
  return url;
}

function readSslConfig(options) {
  if (options.ssl !== undefined) {
    return options.ssl;
  }
  if (process.env.PGSSL === "false") {
    return false;
  }
  if (process.env.NODE_ENV === "production" || process.env.SUPABASE_DB_URL) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function normalizePgError(error) {
  if (!error) return error;

  if (error.code === "23P01") {
    error.message = "booking overlaps an existing active booking";
  } else if (error.code === "23505") {
    const constraint = error.constraint || error.message || "";
    if (constraint.includes("idx_payments_provider_txn") || constraint.includes("provider_txn")) {
      const err = new Error("Transaction reference has already been claimed for another payment");
      err.code = "TRANSACTION_ALREADY_REDEEMED";
      err.detail = "duplicate transaction reference";
      return err;
    }
    if (constraint.includes("idx_bookings_checkout_idempotency") || constraint.includes("checkout_idempotency")) {
      const err = new Error("Booking with this checkout idempotency key already exists");
      err.code = "BOOKING_IDEMPOTENCY_CONFLICT";
      return err;
    }
    if (constraint.includes("refunds_idempotency_key")) {
      const err = new Error("Refund with this idempotency key already exists");
      err.code = "REFUND_IDEMPOTENCY_CONFLICT";
      return err;
    }
    if (constraint.includes("payments_idempotency_key") || constraint.includes("idempotency_key")) {
      const err = new Error("Payment with this idempotency key already exists");
      err.code = "PAYMENT_IDEMPOTENCY_CONFLICT";
      return err;
    }
  }

  return error;
}

module.exports = {
  PgPaymentRepository,
  normalizePgError
};
