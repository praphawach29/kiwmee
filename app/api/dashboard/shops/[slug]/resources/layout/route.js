const { shopRoute } = require("../../../../../../../src/v2/admin-routes");
const { saveLayout } = require("../../../../../../../src/v2/admin-catalog");

// แผนผังสนาม: { items: [{ id, layout: { row, col, w, h } | null }] } — owner only
const PUT = shopRoute((client, shop, body) => saveLayout(client, shop, body?.items));

module.exports = { PUT };
