const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { cancelInvite } = require("../../../../../../../../src/v2/admin-team");

// Owners: withdraw an invite nobody has taken up yet
const DELETE = shopRoute((client, shop, body, { id }) => cancelInvite(client, shop, id), { body: false });

module.exports = { DELETE };
