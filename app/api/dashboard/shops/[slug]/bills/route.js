const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { createSale, listBills } = require("../../../../../../src/v2/admin-bills");

// ?from=YYYY-MM-DD — the day's bills and takings · POST a walk-in sale { title?, customerName?, amount, payments, note? }
const GET = shopRoute((client, shop, body, { query }) => listBills(client, shop, query), { owner: false, read: true });
const POST = shopRoute((client, shop, body) => createSale(client, shop, body), { owner: false });

module.exports = { GET, POST };
