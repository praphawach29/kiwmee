const { cancelBooking } = require("../../../../../src/automation/booking-orchestration");
const { getBookingConfig } = require("../../../../../src/config");
const { getParams, json, readJson, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { optionalString, requireUuid } = require("../../../../../src/validation");
const { authorizeBooking, isAdmin } = require("../../../../../src/security/access");
const { sameOrigin } = require("../../../../../src/security/limits");
const { getRateLimiter, clientKey } = require("../../../../../src/security/rate-limit-runtime");

async function POST(request, context) {
  return route(async () => {
    const params = await getParams(context);
    const bookingId = requireUuid(params.id, "id");
    sameOrigin(request);
    await getRateLimiter().consume("booking-verification", clientKey(request), { max: 30, windowMs: 60000 });
    await authorizeBooking(request, getRepository(), bookingId);
    const payload = await readJson(request);
    const booking = await cancelBooking(getRepository(), bookingId, {
      reason: optionalString(payload.reason),
      actor: isAdmin(request) ? "staff" : "customer",
      changed_by: isAdmin(request) ? "staff" : "customer"
    }, getBookingConfig());
    return json(booking);
  });
}

module.exports = { POST };
