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
    this.transactionCount = 0;
  }

  async transaction(callback) {
    this.transactionCount += 1;
    const snapshot = this.snapshot();
    try {
      return await callback(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  snapshot() {
    return {
      bookings: structuredClone(this.bookings),
      customers: structuredClone(this.customers),
      bookingStatusHistory: structuredClone(this.bookingStatusHistory),
      automationJobs: structuredClone(this.automationJobs),
      automationLogs: structuredClone(this.automationLogs)
    };
  }

  restore(snapshot) {
    this.bookings = snapshot.bookings;
    this.customers = snapshot.customers;
    this.bookingStatusHistory = snapshot.bookingStatusHistory;
    this.automationJobs = snapshot.automationJobs;
    this.automationLogs = snapshot.automationLogs;
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
}

class HistoryFailingRepository extends FakeRepository {
  async insertBookingStatusHistory() {
    throw new Error("forced history failure");
  }
}

function buildSeed() {
  return {
    services: [
      { id: "svc-cut", name: "Cut", duration_minutes: 60, active: true },
      { id: "svc-color", name: "Color", duration_minutes: 120, active: true }
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
