const {
  addMinutes,
  bkkDateRange,
  maxDate,
  minDate,
  overlaps,
  toBangkokISOString
} = require("./time");

const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed", "checked_in", "completed"];

async function getAvailableSlots(repository, options) {
  const service = await repository.getActiveService(options.serviceId);
  if (!service) {
    throw new Error("service not found or inactive");
  }

  const staffList = options.staffId
    ? [await requireEligibleStaff(repository, options.staffId, options.serviceId)]
    : await repository.listActiveStaffForService(options.serviceId);

  const { start: dayStart, end: dayEnd } = bkkDateRange(options.date);
  const slotStepMinutes = options.slotStepMinutes ?? 15;
  const slots = [];

  for (const staffMember of staffList.filter(Boolean)) {
    const availabilityRows = await repository.listAvailabilityForStaff(
      staffMember.id,
      dayStart,
      dayEnd
    );
    const bookings = await repository.listBookingsForStaff(
      staffMember.id,
      dayStart,
      dayEnd,
      ACTIVE_BOOKING_STATUSES,
      options.excludeBookingId
    );

    const workingWindows = availabilityRows.filter((row) => row.type === "available");
    const blockedWindows = availabilityRows.filter((row) => row.type === "blocked");

    for (const window of workingWindows) {
      const windowStart = maxDate(new Date(window.start_at), dayStart);
      const windowEnd = minDate(new Date(window.end_at), dayEnd);

      for (
        let slotStart = new Date(windowStart);
        addMinutes(slotStart, service.duration_minutes) <= windowEnd;
        slotStart = addMinutes(slotStart, slotStepMinutes)
      ) {
        const slotEnd = addMinutes(slotStart, service.duration_minutes);
        if (hasOverlap(slotStart, slotEnd, blockedWindows) || hasOverlap(slotStart, slotEnd, bookings)) {
          continue;
        }

        slots.push({
          staff_id: staffMember.id,
          start_at: toBangkokISOString(slotStart),
          end_at: toBangkokISOString(slotEnd)
        });
      }
    }
  }

  slots.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.staff_id.localeCompare(b.staff_id));
  return { date: options.date, slots };
}

async function isSlotAvailable(repository, options) {
  const slots = await getAvailableSlots(repository, options);
  const requestedStart = toBangkokISOString(new Date(options.startAt));
  return slots.slots.some((slot) => slot.staff_id === options.staffId && slot.start_at === requestedStart);
}

async function requireEligibleStaff(repository, staffId, serviceId) {
  const staff = await repository.getActiveStaff(staffId);
  if (!staff) {
    throw new Error("staff not found or inactive");
  }

  const canPerformService = await repository.staffCanPerformService(staffId, serviceId);
  if (!canPerformService) {
    throw new Error("staff cannot perform service");
  }

  return staff;
}

function hasOverlap(start, end, rows) {
  return rows.some((row) => overlaps(start, end, new Date(row.start_at), new Date(row.end_at)));
}

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  getAvailableSlots,
  isSlotAvailable,
  requireEligibleStaff
};
