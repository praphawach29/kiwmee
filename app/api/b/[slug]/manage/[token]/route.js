const { getParams, json, route } = require("../../../../../../src/http");
const { getBookingPool } = require("../../../../../../src/v2/db");
const { findManaged } = require("../../../../../../src/v2/manage-booking");
const { clientKey, rateLimit } = require("../../../../../../src/v2/public-booking");

// The customer's own booking, opened from the link they got after booking
async function GET(request, context) {
  return route(async () => {
    const { slug, token } = await getParams(context);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "manage", 60, 60);
    return json(await findManaged(db, slug, token));
  });
}

module.exports = { GET };
