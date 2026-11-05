const { brandRoute } = require("../../../../../../../src/v2/admin-routes");
const { buy } = require("../../../../../../../src/v2/wallet");

// ซื้อแพ็กเกจ/แพ็กเสริมจากยอดในกระเป๋า: body = { sku }
const POST = brandRoute((client, body, params, user) => buy(params.id, user.id, body?.sku));

module.exports = { POST };
