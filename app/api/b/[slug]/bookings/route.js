const { getParams, json, route } = require("../../../../../src/http");
const { boundedJson } = require("../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../src/v2/db");
const { book, clientKey, rateLimit } = require("../../../../../src/v2/public-booking");

async function POST(request, context) {
  return route(async () => {
    const { slug } = await getParams(context);
    const body = await boundedJson(request);
    const db = getBookingPool();
    // a few bookings per client per 10 minutes is plenty for a real customer
    await rateLimit(db, clientKey(request), "book", Number(process.env.BOOKING_BOOK_LIMIT) || 5, 600);
    return json(await book(db, slug, body), 201);
  });
}

module.exports = { POST };
