const { bkkDateRange } = require("../../../../src/time");
const { json, route } = require("../../../../src/http");
const { getRepository } = require("../../../../src/repositories");
const { requireDate } = require("../../../../src/validation");
const { requireAdmin } = require("../../../../src/security/access");

async function GET(request) {
  return route(async () => {
    await requireAdmin(request);
    const url = new URL(request.url);
    const date = requireDate(url.searchParams.get("date"), "date");
    const range = bkkDateRange(date);
    const bookings = await getRepository().listAdminBookingsForDate(range.start, range.end);
    return json({ date, bookings });
  });
}

module.exports = { GET };
