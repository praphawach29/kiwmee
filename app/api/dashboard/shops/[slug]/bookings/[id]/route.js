const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { rescheduleBooking, notifyChange } = require("../../../../../../../src/v2/admin-bookings");
const { getBookingPool } = require("../../../../../../../src/v2/db");

// Move a booking: { date, time, resourceId?, durationMinutes? }
// A customer who booked inside LINE is told there (a card that cannot be sent does not undo the move).
const PUT = shopRoute(async (client, shop, body, { id }) => {
  const result = await rescheduleBooking(client, shop, id, body);
  const line = await notifyChange(client, shop, id, "moved", { previous: result.previous, db: getBookingPool() });
  return { id: result.id, ...(line ? { line } : {}) };
}, { owner: false });

module.exports = { PUT };
