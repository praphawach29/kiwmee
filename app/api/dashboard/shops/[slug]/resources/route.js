const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { saveResource } = require("../../../../../../src/v2/admin-catalog");

const POST = shopRoute((client, shop, body) => saveResource(client, shop, null, body));

module.exports = { POST };
