const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { deleteOffering, saveOffering } = require("../../../../../../../src/v2/admin-catalog");

const PUT = shopRoute((client, shop, body, { id }) => saveOffering(client, shop, id, body));
// an offering with bookings is switched off instead of deleted
const DELETE = shopRoute((client, shop, body, { id }) => deleteOffering(client, shop, id), { body: false });

module.exports = { PUT, DELETE };
