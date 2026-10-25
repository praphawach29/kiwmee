const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { deleteTimeOff } = require("../../../../../../../src/v2/admin-catalog");

const DELETE = shopRoute((client, shop, body, { id }) => deleteTimeOff(client, shop, id), { body: false });

module.exports = { DELETE };
