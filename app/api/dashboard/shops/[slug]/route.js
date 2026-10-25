const { shopRoute } = require("../../../../../src/v2/admin-routes");
const { getCatalog, saveShop } = require("../../../../../src/v2/admin-catalog");

// Everything the admin page edits (members read); owners save name, booking rules and hours
const GET = shopRoute((client, shop) => getCatalog(client, shop), { owner: false, read: true });
const PUT = shopRoute(async (client, shop, body) => {
  await saveShop(client, shop, body);
});

module.exports = { GET, PUT };
