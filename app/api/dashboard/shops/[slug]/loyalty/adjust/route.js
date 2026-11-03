const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { adjustPoints } = require("../../../../../../../src/v2/loyalty");

// { lineUserId, points, note? } — the brand's owner gives or takes points by hand
const POST = shopRoute((client, shop, body) => adjustPoints(client, shop, body), { owner: false });

module.exports = { POST };
