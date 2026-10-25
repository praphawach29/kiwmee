const { getParams, json, route } = require("../../../../src/http");
const { getBookingPool } = require("../../../../src/v2/db");
const { clientKey, rateLimit, shopInfo } = require("../../../../src/v2/public-booking");

async function GET(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "shop", 120, 60);
    return json(await shopInfo(db, slug));
  });
}

module.exports = { GET };
