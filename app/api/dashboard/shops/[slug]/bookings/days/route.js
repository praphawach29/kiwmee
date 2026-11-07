const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { bookingDays } = require("../../../../../../../src/v2/admin-bookings");

// ?from=YYYY-MM-DD&days=42 — how many bookings each day has, for the month view (members, staff too)
const GET = shopRoute((client, shop, body, { query }) => bookingDays(client, shop, query), { owner: false, read: true });

module.exports = { GET };
