const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { saveOffering } = require("../../../../../../src/v2/admin-catalog");

const POST = shopRoute((client, shop, body) => saveOffering(client, shop, null, body));

module.exports = { POST };
