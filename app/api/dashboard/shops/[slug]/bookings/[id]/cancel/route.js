const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { cancelBooking } = require("../../../../../../../../src/v2/admin-bookings");

// { reason? }
const POST = shopRoute((client, shop, body, { id }) => cancelBooking(client, shop, id, body), { owner: false });

module.exports = { POST };
