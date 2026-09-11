const { randomUUID } = require("node:crypto");
const { overlaps } = require("../src/time");

class FakeRepository {
  constructor(seed = {}) {
    this.services = seed.services ?? [];
    this.staff = seed.staff ?? [];
    this.staffServices = seed.staffServices ?? [];
    this.availability = seed.availability ?? [];
    this.bookings = seed.bookings ?? [];
    this.customers = seed.customers ?? [];
    this.bookingStatusHistory = seed.bookingStatusHistory ?? [];
    this.automationJobs = seed.automationJobs ?? [];
    this.automationLogs = seed.automationLogs ?? [];
    this.payments = seed.payments ?? [];
    this.paymentAllocations = seed.paymentAllocations ?? [];
    this.paymentAttempts = seed.paymentAttempts ?? [];
    this.paymentEvents = seed.paymentEvents ?? [];
    this.refunds = seed.refunds ?? [];
    this.transactionCount = 0;
    this.inTransaction = false;
    this.txLock = Promise.resolve();
  }

  async transaction(callback) {
    if (this.inTransaction) {
      return callback(this);
    }

    const prev = this.txLock;
    let release;
    this.txLock = new Promise((resolve) => { release = resolve; });
    await prev;

    this.inTransaction = true;
    this.transactionCount += 1;
    const snapshot = this.snapshot();
    try {
      return await callback(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      this.inTransaction = false;
      release();
    }
  }

  snapshot() {
    return {
      bookings: structuredClone(this.bookings),
      customers: structuredClone(this.customers),
      bookingStatusHistory: structuredClone(this.bookingStatusHistory),
      automationJobs: structuredClone(this.automationJobs),
      automationLogs: structuredClone(this.automationLogs),
      payments: structuredClone(this.payments),
      paymentAllocations: structuredClone(this.paymentAllocations),
      paymentAttempts: structuredClone(this.paymentAttempts),
      paymentEvents: structuredClone(this.paymentEvents),
      refunds: structuredClone(this.refunds)
    };
  }

  restore(snapshot) {
    this.bookings = snapshot.bookings;
    this.customers = snapshot.customers;
    this.bookingStatusHistory = snapshot.bookingStatusHistory;
    this.automationJobs = snapshot.automationJobs;
    this.automationLogs = snapshot.automationLogs;
    this.payments = snapshot.payments;
    this.paymentAllocations = snapshot.paymentAllocations;
    this.paymentAttempts = snapshot.paymentAttempts;
    this.paymentEvents = snapshot.paymentEvents;
    this.refunds = snapshot.refunds;
  }

  async lockStaffSchedule(staffId) {
    this.lockedStaffId = staffId;
  }

  async getActiveService(serviceId) {
    return this.services.find((service) => service.id === serviceId && service.active !== false) ?? null;
  }

  async getActiveStaff(staffId) {
    return this.staff.find((staff) => staff.id === staffId && staff.active !== false) ?? null;
  }

  async staffCanPerformService(staffId, serviceId) {
    return this.staffServices.some((row) => row.staff_id === staffId && row.service_id === serviceId);
  }

  async listActiveStaffForService(serviceId) {
    const staffIds = new Set(
      this.staffServices
        .filter((row) => row.service_id === serviceId)
        .map((row) => row.staff_id)
    );
    return this.staff.filter((staff) => staff.active !== false && staffIds.has(staff.id));
  }

  async listAvailabilityForStaff(staffId, start, end) {
    return this.availability.filter((row) => (
      row.staff_id === staffId &&
      overlaps(new Date(row.start_at), new Date(row.end_at), start, end)
    ));
  }

  async listBookingsForStaff(staffId, start, end, statuses, excludeBookingId) {
    return this.bookings.filter((booking) => (
      booking.staff_id === staffId &&
      booking.id !== excludeBookingId &&
      statuses.includes(booking.status) &&
      overlaps(new Date(booking.start_at), new Date(booking.end_at), start, end)
    ));
  }

  async findCustomerByContact(contact) {
    return this.customers.find((customer) => (
      (contact.phone && customer.phone === contact.phone) ||
      (contact.email && customer.email === contact.email) ||
      (contact.line_user_id && customer.line_user_id === contact.line_user_id)
    )) ?? null;
  }

  async insertCustomer(customer) {
    const row = { id: randomUUID(), ...customer };
    this.customers.push(row);
    return row;
  }

  async insertBooking(booking) {
    if (booking.checkout_idempotency_key) {
      const existing = this.bookings.find(
        (b) => b.checkout_idempotency_key === booking.checkout_idempotency_key
      );
      if (existing) {
        const err = new Error("Booking with this checkout idempotency key already exists");
        err.code = "BOOKING_IDEMPOTENCY_CONFLICT";
        throw err;
      }
    }

    const start = new Date(booking.start_at);
    const end = new Date(booking.end_at);
    const conflicts = this.bookings.some((existing) => (
      existing.staff_id === booking.staff_id &&
      ["pending", "confirmed", "checked_in", "completed"].includes(existing.status) &&
      overlaps(start, end, new Date(existing.start_at), new Date(existing.end_at))
    ));
    if (conflicts) {
      throw new Error("database overlap constraint violation");
    }

    const row = { id: randomUUID(), ...booking };
    this.bookings.push(row);
    return row;
  }

  async insertBookingStatusHistory(history) {
    const row = { id: randomUUID(), ...history };
    this.bookingStatusHistory.push(row);
    return row;
  }

  async getBookingForUpdate(bookingId) {
    return this.bookings.find((booking) => booking.id === bookingId) ?? null;
  }

  async getBooking(bookingId) {
    return this.getBookingForUpdate(bookingId);
  }

  async getBookingById(bookingId) {
    return this.getBookingForUpdate(bookingId);
  }

  async findBookingByIdempotencyKey(key) {
    return this.bookings.find((booking) => booking.checkout_idempotency_key === key) ?? null;
  }

  async updateBookingTime(bookingId, patch) {
    const booking = await this.getBookingForUpdate(bookingId);
    if (!booking) {
      return null;
    }

    const conflicts = this.bookings.some((existing) => (
      existing.id !== bookingId &&
      existing.staff_id === patch.staff_id &&
      ["pending", "confirmed", "checked_in", "completed"].includes(existing.status) &&
      overlaps(new Date(patch.start_at), new Date(patch.end_at), new Date(existing.start_at), new Date(existing.end_at))
    ));
    if (conflicts) {
      throw new Error("database overlap constraint violation");
    }

    Object.assign(booking, patch);
    return booking;
  }

  async updateBookingStatus(bookingId, status) {
    const booking = await this.getBookingForUpdate(bookingId);
    if (!booking) {
      return null;
    }

    booking.status = status;
    return booking;
  }

  async enqueueAutomationJob(job) {
    const existing = this.automationJobs.find((row) => row.event_key === job.event_key);
    if (existing) {
      return existing;
    }

    const row = {
      id: randomUUID(),
      status: "pending",
      attempts: 0,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...job,
      payload: job.payload ?? {}
    };
    this.automationJobs.push(row);
    return row;
  }

  async cancelPendingAutomationJobs(bookingId, automationTypes, exceptEventKey = null) {
    const cancelled = [];
    for (const job of this.automationJobs) {
      if (
        job.booking_id === bookingId &&
        automationTypes.includes(job.automation_type) &&
        job.event_key !== exceptEventKey &&
        ["pending", "failed"].includes(job.status)
      ) {
        job.status = "cancelled";
        cancelled.push(job);
      }
    }
    return cancelled;
  }

  async claimDueAutomationJobs(now, limit = 25) {
    const due = this.automationJobs
      .filter((job) => ["pending", "failed"].includes(job.status) && new Date(job.scheduled_at) <= now)
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
      .slice(0, limit);

    for (const job of due) {
      job.status = "processing";
      job.attempts += 1;
      job.last_error = null;
    }
    return due;
  }

  async completeAutomationJob(jobId, log) {
    const job = this.automationJobs.find((row) => row.id === jobId);
    if (!job) {
      return null;
    }

    if (!this.automationLogs.some((row) => row.event_key === log.event_key)) {
      this.automationLogs.push({ id: randomUUID(), created_at: new Date().toISOString(), ...log });
    }

    job.status = "completed";
    job.last_error = null;
    return job;
  }

  async failAutomationJob(jobId, message) {
    const job = this.automationJobs.find((row) => row.id === jobId);
    if (!job) {
      return null;
    }

    job.status = "failed";
    job.last_error = message;
    return job;
  }

  async getAutomationJobForUpdate(id) {
    return this.automationJobs.find((job) => job.id === id);
  }

  async hasAutomationLog(key) {
    return this.automationLogs.some((log) => log.event_key === key);
  }

  async cancelAutomationJob(id) {
    const job = this.automationJobs.find((row) => row.id === id);
    if (job) job.status = "cancelled";
  }

  async listAutomationJobsForBooking(bookingId) {
    return this.automationJobs.filter((job) => job.booking_id === bookingId);
  }

  async listConfirmedBookingsPastNoShowCutoff(cutoff) {
    return this.bookings.filter((booking) => (
      booking.status === "confirmed" &&
      new Date(booking.start_at) < cutoff
    ));
  }

  async listBookingsForAutomationReconciliation() {
    return this.bookings.filter((booking) => {
      if (booking.status === "confirmed") {
        return !this.automationJobs.some((job) => (
          job.booking_id === booking.id &&
          ["booking_confirmation", "appointment_reminder"].includes(job.automation_type) &&
          ["pending", "processing", "completed", "failed"].includes(job.status)
        ));
      }
      if (booking.status === "cancelled") {
        return !this.automationJobs.some((job) => job.booking_id === booking.id && job.automation_type === "booking_cancellation");
      }
      if (booking.status === "no_show") {
        return !this.automationJobs.some((job) => job.booking_id === booking.id && job.automation_type === "no_show_followup");
      }
      if (booking.status === "completed") {
        return !this.automationJobs.some((job) => job.booking_id === booking.id && job.automation_type === "post_service_followup");
      }
      return false;
    });
  }

  // --- Payment Domain Support ---
  async createPayment(payment) {
    const row = { id: randomUUID(), ...payment };
    this.payments.push(row);
    return row;
  }

  async insertPayment(payment) {
    return this.createPayment(payment);
  }

  async getPaymentById(paymentId) {
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }

  async getPaymentByIdForUpdate(paymentId) {
    return this.payments.find((p) => p.id === paymentId) ?? null;
  }

  async getPaymentForUpdate(paymentId) {
    return this.getPaymentByIdForUpdate(paymentId);
  }

  async updatePayment(paymentId, patch) {
    const payment = await this.getPaymentForUpdate(paymentId);
    if (!payment) return null;
    Object.assign(payment, patch);
    return payment;
  }

  async findPaymentByIdempotencyKey(key) {
    return this.payments.find((p) => p.idempotency_key === key) ?? null;
  }

  async findPaymentByTransactionReference(namespace, reference) {
    return this.payments.find((p) => p.transaction_namespace === namespace && p.transaction_reference === reference) ?? null;
  }

  async findPaymentByTransaction(namespace, reference) {
    return this.findPaymentByTransactionReference(namespace, reference);
  }

  async getPaymentsByBookingId(bookingId) {
    return this.payments.filter((p) => p.original_booking_id === bookingId);
  }

  async findPaymentByBookingId(bookingId) {
    return this.payments.find((p) => p.original_booking_id === bookingId) ?? null;
  }

  async createPaymentAllocation(allocation) {
    const row = { id: randomUUID(), ...allocation };
    this.paymentAllocations.push(row);
    return row;
  }

  async insertPaymentAllocation(allocation) {
    return this.createPaymentAllocation(allocation);
  }

  async getActivePaymentAllocation(bookingId, paymentId = null) {
    return this.paymentAllocations.find((a) => (
      a.booking_id === bookingId &&
      a.status === "active" &&
      (!paymentId || a.payment_id === paymentId)
    )) ?? null;
  }

  async getPaymentAllocations(paymentId) {
    return this.paymentAllocations.filter((a) => a.payment_id === paymentId);
  }

  async updatePaymentAllocation(id, patch) {
    const alloc = this.paymentAllocations.find((a) => a.id === id);
    if (!alloc) return null;
    Object.assign(alloc, patch);
    return alloc;
  }

  async createPaymentAttempt(attempt) {
    const row = { id: randomUUID(), ...attempt };
    this.paymentAttempts.push(row);
    return row;
  }

  async insertPaymentAttempt(attempt) {
    return this.createPaymentAttempt(attempt);
  }

  async createPaymentEvent(event) {
    const row = { id: randomUUID(), ...event };
    this.paymentEvents.push(row);
    return row;
  }

  async insertPaymentEvent(event) {
    return this.createPaymentEvent(event);
  }

  async createRefund(refund) {
    const row = { id: randomUUID(), ...refund };
    this.refunds.push(row);
    return row;
  }

  async insertRefund(refund) {
    return this.createRefund(refund);
  }

  async getRefundForUpdate(refundId) {
    return this.refunds.find((r) => r.id === refundId) ?? null;
  }

  async updateRefund(refundId, patch) {
    const refund = await this.getRefundForUpdate(refundId);
    if (!refund) return null;
    Object.assign(refund, patch);
    return refund;
  }

  async getRefundsByPayment(paymentId) {
    return this.refunds.filter((r) => r.payment_id === paymentId);
  }

  async getRefundsForPayment(paymentId) {
    return this.getRefundsByPayment(paymentId);
  }

  async findRefundByIdempotencyKey(key) {
    return this.refunds.find((r) => r.idempotency_key === key) ?? null;
  }
}

class HistoryFailingRepository extends FakeRepository {
  async insertBookingStatusHistory() {
    throw new Error("forced history failure");
  }
}

function buildSeed() {
  return {
    services: [
      { id: "svc-cut", name: "Cut", duration_minutes: 60, price: 500, active: true },
      { id: "svc-color", name: "Color", duration_minutes: 120, price: 1500, active: true }
    ],
    staff: [
      { id: "staff-ann", name: "Ann", active: true },
      { id: "staff-mean", name: "Mean", active: true }
    ],
    staffServices: [
      { staff_id: "staff-ann", service_id: "svc-cut" },
      { staff_id: "staff-ann", service_id: "svc-color" },
      { staff_id: "staff-mean", service_id: "svc-cut" }
    ],
    availability: [
      {
        staff_id: "staff-ann",
        start_at: "2026-09-10T10:00:00+07:00",
        end_at: "2026-09-10T18:00:00+07:00",
        type: "available"
      },
      {
        staff_id: "staff-ann",
        start_at: "2026-09-10T12:00:00+07:00",
        end_at: "2026-09-10T13:00:00+07:00",
        type: "blocked"
      },
      {
        staff_id: "staff-mean",
        start_at: "2026-09-10T10:00:00+07:00",
        end_at: "2026-09-10T14:00:00+07:00",
        type: "available"
      }
    ],
    bookings: [],
    customers: []
  };
}

module.exports = {
  FakeRepository,
  HistoryFailingRepository,
  buildSeed
};
