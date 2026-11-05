const { brandRoute } = require("../../../../../../src/v2/admin-routes");
const { walletOf } = require("../../../../../../src/v2/wallet");

// กระเป๋าเงินของแบรนด์: ยอดคงเหลือ แพ็กเกจที่ใช้ โควตาที่ใช้ไป และรายการล่าสุด
const GET = brandRoute((client, body, params, user) => walletOf(params.id, user.id), { read: true });

module.exports = { GET };
