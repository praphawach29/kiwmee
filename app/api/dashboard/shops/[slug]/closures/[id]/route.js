const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { deleteClosure } = require("../../../../../../../src/v2/admin-catalog");

const DELETE = shopRoute((client, shop, body, { id }) => deleteClosure(client, shop, id), { body: false });

module.exports = { DELETE };
