const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { confirmDeposit, lineCard } = require("../../../../../../../../src/v2/admin-bookings");
const { pushLine } = require("../../../../../../../../src/v2/line-notify");
const { getBookingPool } = require("../../../../../../../../src/v2/db");

// { amount?, method? } — the deposit is in: confirm the booking and put the deposit on its bill.
// A customer who booked inside LINE is told there (a card that cannot be sent does not undo this).
const POST = shopRoute(async (client, shop, body, { id }) => {
  const result = await confirmDeposit(client, shop, id, body);
  const message = await lineCard(client, shop, id, "confirmed");
  if (message) result.line = await pushLine(getBookingPool(), message.to, [message.card]);
  return result;
}, { owner: false });

module.exports = { POST };
