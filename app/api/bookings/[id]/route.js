const { getParams, json, route } = require("../../../../src/http");
const { getRepository } = require("../../../../src/repositories");
const { notFound } = require("../../../../src/errors");
const { requireUuid } = require("../../../../src/validation");
const { authorizeBooking } = require("../../../../src/security/access");
const { getRateLimiter, clientKey } = require("../../../../src/security/rate-limit-runtime");

async function GET(_request, context) {
  return route(async () => {
    const params = await getParams(context);
    const bookingId = requireUuid(params.id, "id");
    await getRateLimiter().consume("booking-verification", clientKey(_request), { max: 30, windowMs: 60000 });
    await authorizeBooking(_request, getRepository(), bookingId);
    const booking = await getRepository().getBookingDetail(bookingId);
    if (!booking) {
      throw notFound("booking not found");
    }
    return json(booking);
  });
}

module.exports = { GET };
