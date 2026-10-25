const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { saveFlow } = require("../../../../../../src/v2/admin-catalog");

const PUT = shopRoute(async (client, shop, body) => {
  await saveFlow(client, shop, body);
});

module.exports = { PUT };
