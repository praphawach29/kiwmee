const { getParams, json, route } = require("../../../../../../src/http");
const { boundedJson } = require("../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../src/v2/db");
const { clientKey, rateLimit } = require("../../../../../../src/v2/public-booking");
const { myMemberCode } = require("../../../../../../src/v2/my-bookings");

// The member's 6-digit code for the counter (10 minutes); LINE says who they are
async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "member-code", 20, 600);
    return json(await myMemberCode(db, slug, body));
  });
}

module.exports = { POST };
