const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { addTimeOff } = require("../../../../../../src/v2/admin-catalog");

const POST = shopRoute((client, shop, body) => addTimeOff(client, shop, body));

module.exports = { POST };
