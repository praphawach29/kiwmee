const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { listActivity } = require("../../../../../../src/v2/admin-activity");

// ?limit=30 — new bookings, moves and cancellations, newest first, with the member's unread count
const GET = shopRoute((client, shop, body, { query }) => listActivity(client, shop, query), { owner: false, read: true });

module.exports = { GET };
