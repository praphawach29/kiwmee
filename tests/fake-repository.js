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
    this.businessHours = seed.businessHours ?? [];
    this.businessClosures = seed.businessClosures ?? [];
    this.staffSchedules = seed.staffSchedules ?? [];
    this.staffTimeOff = seed.staffTimeOff ?? [];
    this.businessBookingSettings = seed.businessBookingSettings ?? [];
    this.claimedLineEvents = new Set();
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
      refunds: structuredClone(this.refunds),
      businessHours: structuredClone(this.businessHours),
      businessClosures: structuredClone(this.businessClosures),
      staffSchedules: structuredClone(this.staffSchedules),
      staffTimeOff: structuredClone(this.staffTimeOff),
      businessBookingSettings: structuredClone(this.businessBookingSettings)
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
    this.businessHours = snapshot.businessHours;
    this.businessClosures = snapshot.businessClosures;
    this.staffSchedules = snapshot.staffSchedules;
    this.staffTimeOff = snapshot.staffTimeOff;
    this.businessBookingSettings = snapshot.businessBookingSettings;
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

  async listAllStaff() {
    return this.staff.filter((staff) => staff.active !== false);
  }

  async listAvailabilityForStaff(staffId, start, end) {
    return this.availability.filter((row) => (
      row.staff_id === staffId &&
      overlaps(new Date(row.start_at), new Date(row.end_at), start, end)
    ));
  }

  async listBookingsForStaff(staffId, start, end, statuses, excludeBookingId) {
    const sStart = start instanceof Date ? start : new Date(start);
    const sEnd = end instanceof Date ? end : new Date(end);
    return this.bookings.filter((booking) => (
      booking.staff_id === staffId &&
      booking.id !== excludeBookingId &&
      statuses.includes(booking.status) &&
      overlaps(new Date(booking.start_at), new Date(booking.end_at), sStart, sEnd)
    ));
  }

  async findConflictingActiveBooking(staffId, start, end, excludeBookingId = null) {
    const rows = await this.listBookingsForStaff(staffId, start, end, ["pending", "confirmed"], excludeBookingId);
    return rows[0] || null;
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

  async enqueueAutomationJob(job) {
    let existing = this.automationJobs.find((j) => j.event_key === job.event_key);
    if (existing) {
      existing.payload = job.payload ?? existing.payload;
      return existing;
    }
    const row = {
      id: randomUUID(),
      booking_id: job.booking_id,
      automation_type: job.automation_type,
      event_key: job.event_key,
      scheduled_at: job.scheduled_at,
      status: "pending",
      payload: job.payload ?? {},
      attempts: 0,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
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

  async findPendingPaymentsByCustomer(customerId, statuses = ["pending", "slip_received", "verifying", "payment_failed", "payment_manual_review"]) {
    return this.payments.filter((p) => {
      const bk = this.bookings.find((b) => b.id === p.original_booking_id);
      return bk && bk.customer_id === customerId && statuses.includes(p.status) && ["pending", "confirmed"].includes(bk.status);
    });
  }

  async listPaymentsForManualReview(options = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const businessId = options.businessId ?? null;
    return this.payments
      .filter((p) => p.status === "manual_review" && (!businessId || p.business_id === businessId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit)
      .map((p) => {
        const b = this.bookings.find((bk) => bk.id === p.original_booking_id);
        const s = b ? this.services.find((sv) => sv.id === b.service_id) : null;
        const st = b ? this.staff.find((stf) => stf.id === b.staff_id) : null;
        const c = b ? this.customers.find((cst) => cst.id === b.customer_id) : null;
        return {
          payment_id: p.id,
          business_id: p.business_id,
          payment_status: p.status,
          amount_due: p.amount_due,
          currency: p.currency,
          provider: p.provider,
          expires_at: p.expires_at,
          manual_review_deadline: p.manual_review_deadline,
          payment_created_at: p.created_at,
          review_status: p.review_status,
          booking_id: b?.id,
          booking_status: b?.status,
          start_at: b?.start_at,
          end_at: b?.end_at,
          service_name: s?.name,
          staff_name: st?.name,
          customer_name: c?.name
        };
      });
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

  async updatePaymentAttempt(id, patch) {
    const attempt = this.paymentAttempts.find((a) => a.id === id);
    if (!attempt) return null;
    Object.assign(attempt, patch);
    return attempt;
  }

  async findPaymentAttemptBySlipHash(slipHash) {
    if (!slipHash) return null;
    return this.paymentAttempts.find((a) => a.slip_hash === slipHash) ?? null;
  }

  async getPaymentAttempts(paymentId) {
    return this.paymentAttempts.filter((a) => a.payment_id === paymentId);
  }

  async getPaymentAttemptsByPaymentId(paymentId) {
    return this.getPaymentAttempts(paymentId);
  }

  async listPaymentAttempts(paymentId) {
    return this.getPaymentAttempts(paymentId);
  }

  async claimLineEvent(id) {
    if (this.claimedLineEvents.has(id)) return null;
    this.claimedLineEvents.add(id);
    return { id, status: "processing" };
  }

  async completeLineEvent(id) {
    return true;
  }

  async failLineEvent(id) {
    this.claimedLineEvents.delete(id);
    return true;
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

  // =========================================================================
  // Phase A1: Settings & Schedules
  // =========================================================================

  async listBusinessHours(businessId = "default") {
    return this.businessHours
      .filter((h) => (h.business_id || "default") === businessId)
      .sort((a, b) => a.day_of_week - b.day_of_week);
  }

  async upsertBusinessHours(businessId = "default", hoursList = []) {
    const results = [];
    for (const h of hoursList) {
      const idx = this.businessHours.findIndex(
        (item) => (item.business_id || "default") === businessId && item.day_of_week === h.day_of_week
      );
      const row = {
        id: h.id || randomUUID(),
        business_id: businessId,
        day_of_week: h.day_of_week,
        is_open: h.is_open !== false,
        open_time: h.open_time || "10:00",
        close_time: h.close_time || "19:00",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (idx >= 0) {
        this.businessHours[idx] = { ...this.businessHours[idx], ...row };
        results.push(this.businessHours[idx]);
      } else {
        this.businessHours.push(row);
        results.push(row);
      }
    }
    return results;
  }

  async listBusinessClosures(businessId = "default", fromDate = null, toDate = null) {
    return this.businessClosures
      .filter((c) => {
        const matchBiz = (c.business_id || "default") === businessId;
        const d = c.date || c.closure_date;
        if (!matchBiz) return false;
        if (fromDate && toDate) return d >= fromDate && d <= toDate;
        if (fromDate) return d === fromDate;
        return true;
      })
      .map((c) => ({
        ...c,
        date: c.date || c.closure_date,
        closure_date: c.date || c.closure_date,
        is_all_day: c.is_all_day ?? c.is_full_day ?? (!c.start_time && !c.end_time),
        is_full_day: c.is_full_day ?? c.is_all_day ?? (!c.start_time && !c.end_time)
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time || "").localeCompare(b.start_time || ""));
  }

  async createBusinessClosure(arg1, arg2) {
    const businessId = arg2 && typeof arg2 === "object" ? arg1 : (arg1?.business_id || "default");
    const data = arg2 && typeof arg2 === "object" ? arg2 : arg1;
    const dateVal = data.closure_date || data.date;
    const isFullDay = data.is_full_day === true || data.is_all_day === true || (!data.start_time && !data.end_time);
    const row = {
      id: data.id || randomUUID(),
      business_id: businessId,
      date: dateVal,
      closure_date: dateVal,
      start_time: data.start_time || null,
      end_time: data.end_time || null,
      is_full_day: isFullDay,
      is_all_day: isFullDay,
      reason: data.reason || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.businessClosures.push(row);
    return row;
  }

  async deleteBusinessClosure(arg1, arg2 = "default") {
    const isFirstUuid = typeof arg1 === "string" && /^[0-9a-f-]{36}$/i.test(arg1);
    const id = isFirstUuid ? arg1 : arg2;
    const businessId = isFirstUuid ? (arg2 || "default") : arg1;
    const idx = this.businessClosures.findIndex(
      (c) => (c.business_id || "default") === businessId && c.id === id
    );
    if (idx >= 0) {
      this.businessClosures.splice(idx, 1);
      return true;
    }
    return false;
  }

  async listStaffSchedules(businessId = "default", staffId = null) {
    return this.staffSchedules
      .filter((s) => {
        const matchBiz = (s.business_id || "default") === businessId;
        const matchStaff = staffId ? s.staff_id === staffId : true;
        return matchBiz && matchStaff;
      })
      .sort((a, b) => a.day_of_week - b.day_of_week);
  }

  async upsertStaffSchedule(businessId = "default", scheduleList = []) {
    const results = [];
    for (const s of scheduleList) {
      const idx = this.staffSchedules.findIndex(
        (item) => (item.business_id || "default") === businessId &&
                  item.staff_id === s.staff_id &&
                  item.day_of_week === s.day_of_week
      );
      const row = {
        id: s.id || randomUUID(),
        business_id: businessId,
        staff_id: s.staff_id,
        day_of_week: s.day_of_week,
        start_time: s.start_time || "10:00",
        end_time: s.end_time || "19:00",
        is_working: s.is_working !== false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (idx >= 0) {
        this.staffSchedules[idx] = { ...this.staffSchedules[idx], ...row };
        results.push(this.staffSchedules[idx]);
      } else {
        this.staffSchedules.push(row);
        results.push(row);
      }
    }
    return results;
  }

  async listStaffTimeOff(businessId = "default", dateOrFrom = null, staffIdOrTo = null) {
    return this.staffTimeOff
      .filter((t) => {
        const matchBiz = (t.business_id || "default") === businessId;
        const d = t.date || t.start_date;
        if (!matchBiz) return false;
        if (dateOrFrom && d !== dateOrFrom) return false;
        if (staffIdOrTo && t.staff_id !== staffIdOrTo) return false;
        return true;
      })
      .map((t) => ({
        ...t,
        date: t.date || t.start_date,
        start_date: t.date || t.start_date,
        end_date: t.end_date || t.date || t.start_date,
        is_all_day: t.is_all_day ?? t.is_full_day ?? (!t.start_time && !t.end_time),
        is_full_day: t.is_full_day ?? t.is_all_day ?? (!t.start_time && !t.end_time)
      }))
      .sort((a, b) => (a.date || a.start_date).localeCompare(b.date || b.start_date));
  }

  async createStaffTimeOff(arg1, arg2) {
    const businessId = arg2 && typeof arg2 === "object" ? arg1 : (arg1?.business_id || "default");
    const data = arg2 && typeof arg2 === "object" ? arg2 : arg1;
    const dateVal = data.start_date || data.date;
    const isFullDay = data.is_full_day === true || data.is_all_day === true || (!data.start_time && !data.end_time);
    const row = {
      id: data.id || randomUUID(),
      business_id: businessId,
      staff_id: data.staff_id,
      date: dateVal,
      start_date: dateVal,
      end_date: data.end_date || dateVal,
      start_time: data.start_time || null,
      end_time: data.end_time || null,
      is_full_day: isFullDay,
      is_all_day: isFullDay,
      reason: data.reason || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.staffTimeOff.push(row);
    return row;
  }

  async deleteStaffTimeOff(arg1, arg2 = "default") {
    const isFirstUuid = typeof arg1 === "string" && /^[0-9a-f-]{36}$/i.test(arg1);
    const id = isFirstUuid ? arg1 : arg2;
    const businessId = isFirstUuid ? (arg2 || "default") : arg1;
    const idx = this.staffTimeOff.findIndex(
      (t) => (t.business_id || "default") === businessId && t.id === id
    );
    if (idx >= 0) {
      this.staffTimeOff.splice(idx, 1);
      return true;
    }
    return false;
  }

  async getBusinessBookingSettings(businessId = "default") {
    const s = this.businessBookingSettings.find((x) => (x.business_id || "default") === businessId);
    if (!s) return null;
    return {
      ...s,
      lead_time_minutes: s.lead_time_minutes ?? s.booking_min_lead_minutes ?? 15,
      booking_min_lead_minutes: s.booking_min_lead_minutes ?? s.lead_time_minutes ?? 15,
      slot_interval_minutes: s.slot_interval_minutes ?? 15,
      max_advance_days: s.max_advance_days ?? s.max_advance_booking_days ?? 60,
      max_advance_booking_days: s.max_advance_booking_days ?? s.max_advance_days ?? 60
    };
  }

  async updateBusinessBookingSettings(businessId = "default", settings = {}) {
    const idx = this.businessBookingSettings.findIndex(
      (s) => (s.business_id || "default") === businessId
    );
    const lead = settings.lead_time_minutes ?? settings.booking_min_lead_minutes ?? 15;
    const interval = settings.slot_interval_minutes ?? 15;
    const maxDays = settings.max_advance_days ?? settings.max_advance_booking_days ?? 60;
    const row = {
      id: settings.id || randomUUID(),
      business_id: businessId,
      booking_min_lead_minutes: lead,
      lead_time_minutes: lead,
      slot_interval_minutes: interval,
      max_advance_booking_days: maxDays,
      max_advance_days: maxDays,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (idx >= 0) {
      this.businessBookingSettings[idx] = { ...this.businessBookingSettings[idx], ...row };
      return this.businessBookingSettings[idx];
    }
    this.businessBookingSettings.push(row);
    return row;
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
