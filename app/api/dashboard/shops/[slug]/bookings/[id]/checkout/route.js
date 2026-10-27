const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { checkoutBooking } = require("../../../../../../../../src/v2/admin-bills");

// Close the booking's bill: { subtotal?, payments: [{ method, amount }], note? }
const POST = shopRoute((client, shop, body, { id }) => checkoutBooking(client, shop, id, body), { owner: false });

module.exports = { POST };
