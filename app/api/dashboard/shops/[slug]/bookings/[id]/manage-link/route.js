const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { issueManageLink } = require("../../../../../../../../src/v2/admin-bookings");

// A new link for the customer to see, move or cancel this booking (the previous one stops working)
const POST = shopRoute((client, shop, body, { id }) => issueManageLink(client, shop, id), { owner: false });

module.exports = { POST };
