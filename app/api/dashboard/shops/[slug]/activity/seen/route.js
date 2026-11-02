const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { markActivitySeen } = require("../../../../../../../src/v2/admin-activity");

// The signed-in member has looked at the activity
const POST = shopRoute((client, shop) => markActivitySeen(client, shop), { owner: false, body: false });

module.exports = { POST };
