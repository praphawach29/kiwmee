const { brandRoute } = require("../../../../src/v2/admin-routes");
const { listBrands } = require("../../../../src/v2/admin-brands");

// The signed-in user's brands, each with its plan and the branches the user works at
const GET = brandRoute((client) => listBrands(client), { read: true });

module.exports = { GET };
