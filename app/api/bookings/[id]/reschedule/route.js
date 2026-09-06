const { rescheduleBooking } = require("../../../../../src/automation/booking-orchestration");
const { getParams, json, readJson, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { optionalString, optionalUuid, requireTimestamp, requireUuid } = require("../../../../../src/validation");
const { authorizeBooking } = require("../../../../../src/security/access");
const { sameOrigin } = require("../../../../../src/security/limits");
const { getRateLimiter, clientKey } = require("../../../../../src/security/rate-limit-runtime");
const { logEvent } = require("../../../../../src/observability/logger");

async function POST(request, context) {
  return route(async () => {
    const params = await getParams(context);
    const bookingId = requireUuid(params.id, "id");
    sameOrigin(request);
    await getRateLimiter().consume("booking-verification", clientKey(request), { max: 30, windowMs: 60000 });
    await authorizeBooking(request, getRepository(), bookingId);
    const payload = await readJson(request);
    try {
      const booking = await rescheduleBooking(getRepository(), bookingId, {
        staff_id: optionalUuid(payload.staff_id, "staff_id"), start_at: requireTimestamp(payload.start_at, "start_at"),
        reason: optionalString(payload.reason), changed_by: optionalString(payload.changed_by) ?? "web"
      });
      return json(booking);
    } catch (error) {
      if (/not available|overlap|conflict/i.test(error.message ?? "")) logEvent("booking_conflict", { booking_id: bookingId, code: "CONFLICT" });
      throw error;
    }
  });
}

module.exports = { POST };
