const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { deleteAddonGroup, saveAddonGroup } = require("../../../../../../../src/v2/admin-catalog");

const PUT = shopRoute((client, shop, body, { id }) => saveAddonGroup(client, shop, id, body));
// a group whose add-ons bookings took is switched off instead of deleted
const DELETE = shopRoute((client, shop, body, { id }) => deleteAddonGroup(client, shop, id), { body: false });

module.exports = { PUT, DELETE };
