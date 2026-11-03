const { getParams, json, route } = require("../../../../../../src/http");
const { boundedJson } = require("../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../src/v2/db");
const { clientKey, rateLimit } = require("../../../../../../src/v2/public-booking");
const { myRewards } = require("../../../../../../src/v2/my-bookings");

// The member's points and rewards for the booking page (null = this shop runs no points); LINE says who
async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "member-rewards", 60, 600);
    return json(await myRewards(db, slug, body));
  });
}

module.exports = { POST };
