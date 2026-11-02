const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { cancelBooking, notifyChange } = require("../../../../../../../../src/v2/admin-bookings");
const { getBookingPool } = require("../../../../../../../../src/v2/db");

// { reason? } — a customer who booked inside LINE is told there, with the reason if the shop gave one
const POST = shopRoute(async (client, shop, body, { id }) => {
  const result = await cancelBooking(client, shop, id, body);
  const line = await notifyChange(client, shop, id, "cancelled", { reason: result.reason, db: getBookingPool() });
  return { id: result.id, ...(line ? { line } : {}) };
}, { owner: false });

module.exports = { POST };
