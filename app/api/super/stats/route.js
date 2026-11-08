const { superRoute } = require("../../../../src/v2/admin-routes");
const { platformStats } = require("../../../../src/v2/platform-stats");

const GET = superRoute(() => platformStats(), { read: true });

module.exports = { GET };
