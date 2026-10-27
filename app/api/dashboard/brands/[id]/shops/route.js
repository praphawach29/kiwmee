const { brandRoute } = require("../../../../../../src/v2/admin-routes");
const { moveShop } = require("../../../../../../src/v2/admin-brands");

// Bring a shop the user owns into this brand: { slug }
const POST = brandRoute((client, body, { id }) => moveShop(client, id, body));

module.exports = { POST };
