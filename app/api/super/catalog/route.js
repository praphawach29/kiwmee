const { superRoute } = require("../../../../src/v2/admin-routes");
const { listCatalog } = require("../../../../src/v2/platform-catalog");

const GET = superRoute((client) => listCatalog(client), { read: true });

module.exports = { GET };
