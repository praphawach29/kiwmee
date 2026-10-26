const { getParams, json, route } = require("../../../../../../../src/http");
const { boundedJson } = require("../../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../../src/v2/db");
const { manageOptions } = require("../../../../../../../src/v2/manage-booking");
const { clientKey, rateLimit } = require("../../../../../../../src/v2/public-booking");

// { ask: "date" } or { ask: "time", date } — other days and times for the same booking
async function POST(request, context) {
  return route(async () => {
    const { slug, token } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "manage", 60, 60);
    return json(await manageOptions(db, slug, token, body));
  });
}

module.exports = { POST };
