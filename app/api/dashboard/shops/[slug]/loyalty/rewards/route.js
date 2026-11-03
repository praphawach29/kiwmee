const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { saveReward } = require("../../../../../../../src/v2/loyalty");

const POST = shopRoute((client, shop, body) => saveReward(client, shop, null, body), { owner: false });

module.exports = { POST };
