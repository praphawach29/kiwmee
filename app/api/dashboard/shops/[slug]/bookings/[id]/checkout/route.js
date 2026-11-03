const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { checkoutBooking } = require("../../../../../../../../src/v2/admin-bills");
const { notifyTierUp } = require("../../../../../../../../src/v2/loyalty");
const { getBookingPool } = require("../../../../../../../../src/v2/db");

// Close the booking's bill: { subtotal?, payments: [{ method, amount }], note? }
// a member who moved up a tier with this bill hears it in LINE
const POST = shopRoute((client, shop, body, { id }) => checkoutBooking(client, shop, id, body), { owner: false, after: (bill) => bill?.id && notifyTierUp(getBookingPool(), bill.id) });

module.exports = { POST };
