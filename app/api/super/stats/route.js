const { superRoute } = require("../../../../src/v2/admin-routes");
const { platformStats } = require("../../../../src/v2/platform-stats");

const GET = superRoute((_c, _i, user) => platformStats(user.id), { read: true });

module.exports = { GET };
