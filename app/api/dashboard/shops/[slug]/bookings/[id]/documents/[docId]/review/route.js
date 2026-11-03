const { shopRoute } = require("../../../../../../../../../../src/v2/admin-routes");
const { reviewDocument } = require("../../../../../../../../../../src/v2/rental-documents");

// The shop checked it against the person
const POST = shopRoute((client, shop, body, { docId }) => reviewDocument(client, shop, docId), { owner: false, body: false });

module.exports = { POST };
