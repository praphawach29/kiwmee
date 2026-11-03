const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { saveReward } = require("../../../../../../../../src/v2/loyalty");

const PUT = shopRoute((client, shop, body, { id }) => saveReward(client, shop, id, body), { owner: false });

module.exports = { PUT };
