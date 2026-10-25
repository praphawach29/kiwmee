const { shopRoute } = require("../../../../../../src/v2/admin-routes");
const { freeTimes } = require("../../../../../../src/v2/admin-bookings");

// ?offeringId&date&resourceId?&durationMinutes?&partySize?&excludeBookingId?
const GET = shopRoute((client, shop, body, { query }) => freeTimes(client, shop, query), { owner: false, read: true });

module.exports = { GET };
