const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { saveTiers } = require("../../../../../../../src/v2/loyalty");

// Membership tiers: { qualifyMonths, tiers: [{ name, minSpend, minVisits, earnMultiplier, cardTheme, benefits }] }
// The database lets only the brand's owner save them.
const PUT = shopRoute((client, shop, body) => saveTiers(client, shop, body), { owner: false });

module.exports = { PUT };
