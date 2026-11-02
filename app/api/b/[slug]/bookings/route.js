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
    // where the customer's own booking page lives, for the LINE card when no LIFF app is set up
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? new URL(request.url).protocol.replace(":", "");
    const origin = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto === "http" ? "http" : "https"}://${host}` : null;
    return json(await book(db, slug, body, { origin }), 201);
  });
}

module.exports = { POST };
