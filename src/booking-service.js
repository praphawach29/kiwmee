const { getAvailableSlots, requireEligibleStaff } = require("./availability-engine");
const { getBookingConfig } = require("./config");
const { addMinutes, toBangkokISOString } = require("./time");

async function createBooking(repository, input) {
  return repository.transaction(async (tx) => {
    const service = await tx.getActiveService(input.service_id);
    if (!service) {
      throw new Error("service not found or inactive");
    }

    await requireEligibleStaff(tx, input.staff_id, input.service_id);
    await tx.lockStaffSchedule?.(input.staff_id);

    const startAt = new Date(input.start_at);
    const endAt = addMinutes(startAt, service.duration_minutes);
    await assertRequestedSlotAvailable(tx, {
      serviceId: input.service_id,
      staffId: input.staff_id,
      startAt,
      date: toBangkokISOString(startAt).slice(0, 10)
    });

    const customer = await findOrCreateCustomer(tx, input.customer);
    const bookingData = {
      customer_id: customer.id,
      service_id: input.service_id,
      staff_id: input.staff_id,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "confirmed",
      source: input.source ?? "web",
      notes: input.notes ?? null
    };
    if (input.checkout_idempotency_key || input.checkoutIdempotencyKey) {
      bookingData.checkout_idempotency_key = input.checkout_idempotency_key ?? input.checkoutIdempotencyKey;
    }
    const booking = await tx.insertBooking(bookingData);

    await tx.insertBookingStatusHistory({
      booking_id: booking.id,
      from_status: null,
      to_status: booking.status,
      reason: "booking created",
      changed_by: input.changed_by ?? input.source ?? "web"
    });

    return booking;
  });
}

async function rescheduleBooking(repository, bookingId, input) {
  return repository.transaction(async (tx) => {
    const existing = await tx.getBookingForUpdate(bookingId);
    if (!existing) {
      throw new Error("booking not found");
    }
    if (["cancelled", "no_show"].includes(existing.status)) {
      throw new Error("booking cannot be rescheduled from current status");
    }

    const nextStaffId = input.staff_id ?? existing.staff_id;
    const service = await tx.getActiveService(existing.service_id);
    if (!service) {
      throw new Error("service not found or inactive");
    }

    await requireEligibleStaff(tx, nextStaffId, existing.service_id);
    await tx.lockStaffSchedule?.(nextStaffId);

    const startAt = new Date(input.start_at);
    const endAt = addMinutes(startAt, service.duration_minutes);
    await assertRequestedSlotAvailable(tx, {
      serviceId: existing.service_id,
      staffId: nextStaffId,
      startAt,
      date: toBangkokISOString(startAt).slice(0, 10),
      excludeBookingId: bookingId
    });

    const updated = await tx.updateBookingTime(bookingId, {
      staff_id: nextStaffId,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "confirmed"
    });

    await tx.insertBookingStatusHistory({
      booking_id: bookingId,
      from_status: existing.status,
      to_status: "confirmed",
      reason: input.reason ?? "booking rescheduled",
      changed_by: input.changed_by ?? "system"
    });

    return updated;
  });
}

async function cancelBooking(repository, bookingId, input = {}, config = getBookingConfig()) {
  return repository.transaction(async (tx) => {
    const existing = await tx.getBookingForUpdate(bookingId);
    if (!existing) {
      throw new Error("booking not found");
    }
    if (existing.status === "cancelled") {
      return existing;
    }

    if (input.actor === "customer") {
      const cutoff = addMinutes(new Date(existing.start_at), -config.cancellationWindowHours * 60);
      const now = input.now ? new Date(input.now) : new Date();
      if (now > cutoff) {
        throw new Error("cancellation window has passed");
      }
    }

    const updated = await tx.updateBookingStatus(bookingId, "cancelled");
    await tx.insertBookingStatusHistory({
      booking_id: bookingId,
      from_status: existing.status,
      to_status: "cancelled",
      reason: input.reason ?? "booking cancelled",
      changed_by: input.changed_by ?? input.actor ?? "system"
    });

    return updated;
  });
}

async function updateBookingStatus(repository, bookingId, input) {
  return repository.transaction(async (tx) => {
    const existing = await tx.getBookingForUpdate(bookingId);
    if (!existing) {
      throw new Error("booking not found");
    }

    const updated = await tx.updateBookingStatus(bookingId, input.status);
    await tx.insertBookingStatusHistory({
      booking_id: bookingId,
      from_status: existing.status,
      to_status: input.status,
      reason: input.reason ?? null,
      changed_by: input.changed_by ?? "system"
    });

    return updated;
  });
}

async function assertRequestedSlotAvailable(repository, options) {
  const availability = await getAvailableSlots(repository, {
    serviceId: options.serviceId,
    staffId: options.staffId,
    date: options.date,
    excludeBookingId: options.excludeBookingId
  });
  const requestedStart = toBangkokISOString(new Date(options.startAt));
  const match = availability.slots.some((slot) => slot.start_at === requestedStart);

  if (!match) {
    throw new Error("requested slot is not available");
  }
}

async function findOrCreateCustomer(repository, customerInput) {
  const existing = await repository.findCustomerByContact({
    phone: customerInput.phone ?? null,
    email: customerInput.email ?? null,
    line_user_id: customerInput.line_user_id ?? null
  });

  if (existing) {
    return existing;
  }

  return repository.insertCustomer({
    name: customerInput.name,
    phone: customerInput.phone ?? null,
    email: customerInput.email ?? null,
    line_user_id: customerInput.line_user_id ?? null,
    contact_channel: customerInput.contact_channel ?? null,
    notes: customerInput.notes ?? null
  });
}

module.exports = {
  cancelBooking,
  createBooking,
  rescheduleBooking,
  updateBookingStatus
};
