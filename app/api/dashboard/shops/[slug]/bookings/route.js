const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { createBooking, listBookings } = require("../../../../../../src/v2/admin-bookings");

// ?from=YYYY-MM-DD&days=1 — members (staff too) see and take bookings
const GET = shopRoute((client, shop, body, { query }) => listBookings(client, shop, query), { owner: false, read: true });
const POST = shopRoute((client, shop, body) => createBooking(client, shop, body), { owner: false });

module.exports = { GET, POST };
