const { getParams, json, route } = require("../../../../../src/http");
const { boundedJson } = require("../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../src/v2/db");
const { clientKey, rateLimit } = require("../../../../../src/v2/public-booking");
const { myBookings } = require("../../../../../src/v2/my-bookings");

// The customer's own bookings at this shop; LINE's ID token says who they are (src/v2/my-bookings.js)
async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "me", 30, 600);
    return json(await myBookings(db, slug, body));
  });
}

module.exports = { POST };
