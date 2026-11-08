const { brandRoute } = require("../../../../../../../src/v2/admin-routes");
const { topupQr } = require("../../../../../../../src/v2/wallet");

// QR พร้อมเพย์ของบัญชี Kiwmee ใส่ยอดเติมเงินแล้ว: body = { amount }
const POST = brandRoute((client, body, params, user) => topupQr(params.id, user.id, body?.amount));

module.exports = { POST };
