const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { rescheduleBooking } = require("../../../../../../../src/v2/admin-bookings");

// Move a booking: { date, time, resourceId?, durationMinutes? }
const PUT = shopRoute((client, shop, body, { id }) => rescheduleBooking(client, shop, id, body), { owner: false });

module.exports = { PUT };
