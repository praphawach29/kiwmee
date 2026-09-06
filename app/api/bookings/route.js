const { createBooking } = require("../../../src/automation/booking-orchestration");
const { json, readJson, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");
const { validateCreateBookingPayload } = require("../../../src/validation");
const { logEvent } = require("../../../src/observability/logger");

async function POST(request) {
  return route(async () => {
    const payload = validateCreateBookingPayload(await readJson(request));
    try {
      const booking = await createBooking(getRepository(), payload);
      logEvent("booking_created", { booking_id: booking.id, channel: payload.source });
      return json(booking, 201);
    } catch (error) {
      if (/not available|overlap|conflict/i.test(error.message ?? "")) logEvent("booking_conflict", { code: "CONFLICT", channel: payload.source });
      throw error;
    }
  });
}

module.exports = { POST };
