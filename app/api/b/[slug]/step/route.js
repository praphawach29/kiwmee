const { getParams, json, route } = require("../../../../../src/http");
const { boundedJson } = require("../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../src/v2/db");
const { clientKey, rateLimit, step } = require("../../../../../src/v2/public-booking");

async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "step", 240, 60);
    return json(await step(db, slug, body));
  });
}

module.exports = { POST };
