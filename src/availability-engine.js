const { getBookingConfig } = require("./config");
const {
  addMinutes,
  bkkDateRange,
  maxDate,
  minDate,
  overlaps,
  toBangkokISOString
} = require("./time");

const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed", "checked_in"];

const ZERO_AVAILABILITY_REASONS = {
  PAST_WORKING_HOURS: "PAST_WORKING_HOURS",
  BUSINESS_CLOSED: "BUSINESS_CLOSED",
  STAFF_OFF: "STAFF_OFF",
  FULLY_BOOKED: "FULLY_BOOKED",
  NO_WORKING_WINDOW: "NO_WORKING_WINDOW",
  NO_AVAILABLE_SLOTS: "NO_AVAILABLE_SLOTS"
};

async function getAvailableSlots(repository, options) {
  const service = await repository.getActiveService(options.serviceId);
  if (!service) {
    throw new Error("service not found or inactive");
  }

  const businessId = options.businessId || "default";

  // 1. Booking settings precedence: options > business_booking_settings > safe system defaults
  let bookingSettings = null;
  if (typeof repository.getBusinessBookingSettings === "function") {
    try {
      bookingSettings = await repository.getBusinessBookingSettings(businessId);
    } catch {
      // safe fallback if settings table or method fails
    }
  }

  const rawLead = options.leadTimeMinutes ?? options.leadMinutes ?? options.bookingMinLeadMinutes ?? bookingSettings?.lead_time_minutes ?? bookingSettings?.booking_min_lead_minutes;
  const parsedLead = Number(rawLead);
  const leadMinutes = Number.isFinite(parsedLead) && parsedLead >= 0
    ? parsedLead
    : (getBookingConfig().bookingMinLeadMinutes ?? 15);

  const slotStepMinutes = options.slotStepMinutes ?? bookingSettings?.slot_interval_minutes ?? 15;

  // 2. Date & Time context in Asia/Bangkok
  const { start: dayStart, end: dayEnd } = bkkDateRange(options.date);
  const dayOfWeek = new Date(`${options.date}T12:00:00+07:00`).getDay(); // 0=Sunday .. 6=Saturday

  const refNow = options.now !== undefined
    ? (options.now ? new Date(options.now) : null)
    : new Date();

  let todayBangkok = null;
  let isPastDate = false;
  let cutoff = null;

  if (refNow) {
    todayBangkok = toBangkokISOString(refNow).slice(0, 10);
    isPastDate = options.date < todayBangkok;

    if (isPastDate) {
      return {
        date: options.date,
        slots: [],
        availability_status: "unavailable",
        reason: ZERO_AVAILABILITY_REASONS.NO_AVAILABLE_SLOTS
      };
    }

    if (options.date === todayBangkok) {
      cutoff = addMinutes(refNow, leadMinutes);
    }
  }

  // 3. Store Operating Hours from business_hours or safe default (10:00 - 19:00)
  let storeHours = null;
  if (typeof repository.listBusinessHours === "function") {
    try {
      const allHours = await repository.listBusinessHours(businessId);
      if (Array.isArray(allHours) && allHours.length > 0) {
        storeHours = allHours.find((h) => h.day_of_week === dayOfWeek) ?? null;
      }
    } catch {
      // safe fallback
    }
  }

  if (!storeHours) {
    // Default operating hours: Open Mon-Sun 10:00 - 19:00
    storeHours = { is_open: true, open_time: "10:00", close_time: "19:00" };
  }

  // 4. Store Closures / Holidays
  let closures = [];
  if (typeof repository.listBusinessClosures === "function") {
    try {
      closures = await repository.listBusinessClosures(businessId, options.date);
    } catch {
      // safe fallback
    }
  }

  const isStoreHoliday = Array.isArray(closures) && closures.some((c) => Boolean(c.is_all_day || c.is_full_day));

  if (!storeHours.is_open || isStoreHoliday) {
    return {
      date: options.date,
      slots: [],
      availability_status: "unavailable",
      reason: ZERO_AVAILABILITY_REASONS.BUSINESS_CLOSED
    };
  }

  const storeOpenStr = (storeHours.open_time || "10:00").slice(0, 5);
  const storeCloseStr = (storeHours.close_time || "19:00").slice(0, 5);
  const storeOpenDate = new Date(`${options.date}T${storeOpenStr}:00+07:00`);
  const storeCloseDate = new Date(`${options.date}T${storeCloseStr}:00+07:00`);

  if (storeOpenDate >= storeCloseDate) {
    return {
      date: options.date,
      slots: [],
      availability_status: "unavailable",
      reason: ZERO_AVAILABILITY_REASONS.NO_WORKING_WINDOW
    };
  }

  // Check if today and now + leadMinutes is already past store closing time
  const isPastClosingTime = options.date === todayBangkok && cutoff && cutoff >= storeCloseDate;

  // 5. Eligible Staff List
  const staffList = options.staffId
    ? [await requireEligibleStaff(repository, options.staffId, options.serviceId)]
    : await repository.listActiveStaffForService(options.serviceId);

  // Partial closures (e.g. 13:00 - 15:00)
  const partialStoreClosures = (Array.isArray(closures) ? closures : []).filter((c) => !(c.is_all_day || c.is_full_day) && c.start_time && c.end_time).map((c) => ({
    start_at: `${options.date}T${c.start_time.slice(0, 5)}:00+07:00`,
    end_at: `${options.date}T${c.end_time.slice(0, 5)}:00+07:00`
  }));

  const slots = [];
  let candidateSlotsCount = 0;
  let nonPastCandidateSlotsCount = 0;
  let bookedOverlapCount = 0;
  let staffWithWorkingWindowsCount = 0;
  let specificStaffHadNoWindow = false;

  for (const staffMember of staffList.filter(Boolean)) {
    // Check staff weekly schedule
    let staffSchedules = [];
    if (typeof repository.listStaffSchedules === "function") {
      try {
        staffSchedules = await repository.listStaffSchedules(businessId, staffMember.id);
      } catch {
        // safe fallback
      }
    }

    let staffTimeOff = [];
    if (typeof repository.listStaffTimeOff === "function") {
      try {
        staffTimeOff = await repository.listStaffTimeOff(businessId, options.date, staffMember.id);
      } catch {
        // safe fallback
      }
    }

    const hasFullDayTimeOff = Array.isArray(staffTimeOff) && staffTimeOff.some((t) => Boolean(t.is_all_day || t.is_full_day));

    let workingWindows = [];
    let blockedWindows = [...partialStoreClosures];

    // Add partial staff time-off
    for (const t of staffTimeOff.filter((item) => !(item.is_all_day || item.is_full_day) && item.start_time && item.end_time)) {
      blockedWindows.push({
        start_at: `${options.date}T${t.start_time.slice(0, 5)}:00+07:00`,
        end_at: `${options.date}T${t.end_time.slice(0, 5)}:00+07:00`
      });
    }

    if (hasFullDayTimeOff) {
      // Staff has full day time-off
      workingWindows = [];
    } else if (Array.isArray(staffSchedules) && staffSchedules.length > 0) {
      const todaySchedule = staffSchedules.find((s) => s.day_of_week === dayOfWeek);
      if (todaySchedule && todaySchedule.is_working) {
        const staffStartStr = (todaySchedule.start_time || "10:00").slice(0, 5);
        const staffEndStr = (todaySchedule.end_time || "19:00").slice(0, 5);
        const staffStartDate = new Date(`${options.date}T${staffStartStr}:00+07:00`);
        const staffEndDate = new Date(`${options.date}T${staffEndStr}:00+07:00`);

        // Intersection with store hours
        const windowStart = maxDate(staffStartDate, storeOpenDate);
        const windowEnd = minDate(staffEndDate, storeCloseDate);

        if (windowStart < windowEnd) {
          workingWindows.push({
            start_at: toBangkokISOString(windowStart),
            end_at: toBangkokISOString(windowEnd)
          });
        }
      }
    } else {
      // Fallback to legacy availability table for backward compatibility
      const availabilityRows = await repository.listAvailabilityForStaff(
        staffMember.id,
        dayStart,
        dayEnd
      );
      for (const row of availabilityRows.filter((r) => r.type === "available")) {
        const windowStart = maxDate(maxDate(new Date(row.start_at), dayStart), storeOpenDate);
        const windowEnd = minDate(minDate(new Date(row.end_at), dayEnd), storeCloseDate);
        if (windowStart < windowEnd) {
          workingWindows.push({
            start_at: toBangkokISOString(windowStart),
            end_at: toBangkokISOString(windowEnd)
          });
        }
      }
      for (const row of availabilityRows.filter((r) => r.type === "blocked")) {
        blockedWindows.push(row);
      }
    }

    if (workingWindows.length > 0) {
      staffWithWorkingWindowsCount++;
    } else if (options.staffId && options.staffId === staffMember.id) {
      specificStaffHadNoWindow = true;
    }

    // Active bookings
    const bookings = await repository.listBookingsForStaff(
      staffMember.id,
      dayStart,
      dayEnd,
      ACTIVE_BOOKING_STATUSES,
      options.excludeBookingId
    );

    for (const window of workingWindows) {
      const windowStart = new Date(window.start_at);
      const windowEnd = new Date(window.end_at);

      for (
        let slotStart = new Date(windowStart);
        addMinutes(slotStart, service.duration_minutes) <= windowEnd;
        slotStart = addMinutes(slotStart, slotStepMinutes)
      ) {
        candidateSlotsCount++;
        const slotEnd = addMinutes(slotStart, service.duration_minutes);

        const isPastCutoff = cutoff && slotStart <= cutoff;
        if (!isPastCutoff) {
          nonPastCandidateSlotsCount++;
        }

        const overlapsBlocked = hasOverlap(slotStart, slotEnd, blockedWindows);
        const overlapsBooking = hasOverlap(slotStart, slotEnd, bookings);

        if (overlapsBooking) {
          bookedOverlapCount++;
        }

        if (isPastCutoff || overlapsBlocked || overlapsBooking) {
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

  if (slots.length > 0) {
    return {
      date: options.date,
      slots,
      availability_status: "available",
      reason: null
    };
  }

  // Calculate normalized zero-slot reason
  let reason = ZERO_AVAILABILITY_REASONS.NO_AVAILABLE_SLOTS;

  if (options.staffId && specificStaffHadNoWindow) {
    reason = ZERO_AVAILABILITY_REASONS.STAFF_OFF;
  } else if (staffWithWorkingWindowsCount === 0) {
    reason = ZERO_AVAILABILITY_REASONS.NO_WORKING_WINDOW;
  } else if (isPastClosingTime || (options.date === todayBangkok && candidateSlotsCount > 0 && nonPastCandidateSlotsCount === 0)) {
    reason = ZERO_AVAILABILITY_REASONS.PAST_WORKING_HOURS;
  } else if (nonPastCandidateSlotsCount > 0 && bookedOverlapCount >= nonPastCandidateSlotsCount) {
    reason = ZERO_AVAILABILITY_REASONS.FULLY_BOOKED;
  } else if (candidateSlotsCount > 0 && bookedOverlapCount >= candidateSlotsCount) {
    reason = ZERO_AVAILABILITY_REASONS.FULLY_BOOKED;
  }

  return {
    date: options.date,
    slots: [],
    availability_status: "unavailable",
    reason
  };
}

async function isSlotAvailable(repository, options) {
  const result = await getAvailableSlots(repository, options);
  const requestedStart = toBangkokISOString(new Date(options.startAt));
  return result.slots.some((slot) => slot.staff_id === options.staffId && slot.start_at === requestedStart);
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
  ZERO_AVAILABILITY_REASONS,
  getAvailableSlots,
  isSlotAvailable,
  requireEligibleStaff
};
