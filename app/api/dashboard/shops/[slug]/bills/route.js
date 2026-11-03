const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { createSale, listBills } = require("../../../../../../src/v2/admin-bills");
const { notifyTierUp } = require("../../../../../../src/v2/loyalty");
const { getBookingPool } = require("../../../../../../src/v2/db");

// ?from=YYYY-MM-DD — the day's bills and takings · POST a walk-in sale { title?, customerName?, amount, payments, note? }
const GET = shopRoute((client, shop, body, { query }) => listBills(client, shop, query), { owner: false, read: true });
// a member who moved up a tier with this sale hears it in LINE
const POST = shopRoute((client, shop, body) => createSale(client, shop, body), { owner: false, after: (bill) => bill?.id && notifyTierUp(getBookingPool(), bill.id) });

module.exports = { GET, POST };
