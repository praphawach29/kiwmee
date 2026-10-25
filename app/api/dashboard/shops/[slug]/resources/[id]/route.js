const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { deleteResource, saveResource } = require("../../../../../../../src/v2/admin-catalog");

const PUT = shopRoute((client, shop, body, { id }) => saveResource(client, shop, id, body));
// a resource that bookings still point at is switched off instead of deleted
const DELETE = shopRoute((client, shop, body, { id }) => deleteResource(client, shop, id), { body: false });

module.exports = { PUT, DELETE };
