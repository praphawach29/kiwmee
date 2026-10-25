const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { setStatus } = require("../../../../../../../../src/v2/admin-bookings");

// { status: checked_in | completed | no_show | confirmed }
const POST = shopRoute((client, shop, body, { id }) => setStatus(client, shop, id, body), { owner: false });

module.exports = { POST };
