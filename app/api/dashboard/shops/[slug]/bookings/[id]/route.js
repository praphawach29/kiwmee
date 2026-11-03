const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { rescheduleBooking, notifyChange, findBooking } = require("../../../../../../../src/v2/admin-bookings");
const { notFound } = require("../../../../../../../src/errors");
const { getBookingPool } = require("../../../../../../../src/v2/db");

// Move a booking: { date, time, resourceId?, durationMinutes? }
// A customer who booked inside LINE is told there (a card that cannot be sent does not undo the move).
const PUT = shopRoute(async (client, shop, body, { id }) => {
  const result = await rescheduleBooking(client, shop, id, body);
  const line = await notifyChange(client, shop, id, "moved", { previous: result.previous, db: getBookingPool() });
  return { id: result.id, ...(line ? { line } : {}) };
}, { owner: false });

// One booking from the check-in QR (its id) or the 8-character code under it — for the scanner at the desk
const GET = shopRoute(async (client, shop, body, { id }) => {
  const booking = await findBooking(client, shop, id);
  if (!booking) throw notFound("ไม่พบการจองนี้ในร้าน (QR อาจเป็นของร้านอื่น)");
  return booking;
}, { owner: false, read: true });

module.exports = { GET, PUT };
