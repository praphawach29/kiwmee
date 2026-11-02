const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { confirmDeposit } = require("../../../../../../../../src/v2/admin-bookings");

// { amount?, method? } — the deposit is in: confirm the booking and put the deposit on its bill
const POST = shopRoute((client, shop, body, { id }) => confirmDeposit(client, shop, id, body), { owner: false });

module.exports = { POST };
