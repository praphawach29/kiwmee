const { getParams, json, route } = require("../../../../../../src/http");
const { boundedJson } = require("../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../src/v2/db");
const { clientKey, rateLimit } = require("../../../../../../src/v2/public-booking");
const { myWelcome } = require("../../../../../../src/v2/my-bookings");

// The booking page's welcome for a LINE member: name and phone from last time, points, next booking
async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "me", 30, 600);
    return json(await myWelcome(db, slug, body));
  });
}

module.exports = { POST };
