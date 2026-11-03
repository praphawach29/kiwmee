const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { saveLogo } = require("../../../../../../../src/v2/loyalty");

// The brand's logo on its membership card: { logoUrl } (an uploaded image) or { logoUrl: null }
// The database lets only the brand's owner change it.
const PUT = shopRoute((client, shop, body) => saveLogo(client, shop, body), { owner: false });

module.exports = { PUT };
