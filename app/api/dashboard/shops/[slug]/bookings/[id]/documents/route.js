const { shopRoute } = require("../../../../../../../../src/v2/admin-routes");
const { listDocuments } = require("../../../../../../../../src/v2/rental-documents");

// The rental documents of a booking, without the pictures (members)
const GET = shopRoute((client, shop, body, { id }) => listDocuments(client, shop, id), { owner: false, read: true });

module.exports = { GET };
