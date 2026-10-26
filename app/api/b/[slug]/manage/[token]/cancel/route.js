const { getParams, json, route } = require("../../../../../../../src/http");
const { boundedJson } = require("../../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../../src/v2/db");
const { cancelManaged } = require("../../../../../../../src/v2/manage-booking");
const { clientKey, rateLimit } = require("../../../../../../../src/v2/public-booking");

// { reason? }
async function POST(request, context) {
  return route(async () => {
    const { slug, token } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "manage-change", 10, 600);
    return json(await cancelManaged(db, slug, token, body));
  });
}

module.exports = { POST };
