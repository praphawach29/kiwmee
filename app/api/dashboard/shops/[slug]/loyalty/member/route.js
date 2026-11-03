const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { memberAtCounter } = require("../../../../../../../src/v2/loyalty");

// ?code=123456 (walk-in) or ?bookingId=… — the member at the counter, their points and rewards
const GET = shopRoute((client, shop, body, { query }) => memberAtCounter(client, shop, query), { owner: false, read: true });

module.exports = { GET };
