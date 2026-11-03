const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { getLoyalty, saveProgram } = require("../../../../../../src/v2/loyalty");

// Points for LINE members: the rules, rewards and members (members see; the brand's owner changes)
const GET = shopRoute((client, shop) => getLoyalty(client, shop), { owner: false, read: true });
const PUT = shopRoute((client, shop, body) => saveProgram(client, shop, body), { owner: false });

module.exports = { GET, PUT };
