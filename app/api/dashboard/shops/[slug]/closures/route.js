const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { addClosure } = require("../../../../../../src/v2/admin-catalog");

const POST = shopRoute((client, shop, body) => addClosure(client, shop, body));

module.exports = { POST };
