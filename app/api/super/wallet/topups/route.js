const { superRoute } = require("../../../../../src/v2/admin-routes");
const { listTopups, reviewTopup } = require("../../../../../src/v2/wallet");

// สลิปเติมเงินของร้าน: GET = รายการรอตรวจ + ที่ตัดสินแล้ว · POST { id, action: "approve" | "reject" }
const GET = superRoute(() => listTopups(), { read: true });
const POST = superRoute((client, body, user) => reviewTopup(user.id, body?.id, body?.action));

module.exports = { GET, POST };
