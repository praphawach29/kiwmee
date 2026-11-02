const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { saveAddonGroup } = require("../../../../../../src/v2/admin-catalog");

// a group of optional extras with its add-ons and the offerings that offer it (owners only)
const POST = shopRoute((client, shop, body) => saveAddonGroup(client, shop, null, body));

module.exports = { POST };
