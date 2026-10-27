const { brandRoute } = require("../../../../../src/v2/admin-routes");
const { renameBrand } = require("../../../../../src/v2/admin-brands");

// { name } — brand owners
const PUT = brandRoute((client, body, { id }) => renameBrand(client, id, body));

module.exports = { PUT };
