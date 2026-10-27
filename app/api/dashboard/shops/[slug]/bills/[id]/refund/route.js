const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { refundBill } = require("../../../../../../../../src/v2/admin-bills");

// { amount, method, reason? } — owners only
const POST = shopRoute((client, shop, body, { id }) => refundBill(client, shop, id, body));

module.exports = { POST };
