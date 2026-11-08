const { superRoute } = require("../../../../src/v2/admin-routes");
const { revenueReport } = require("../../../../src/v2/platform-revenue");

// รายงานรายได้สำหรับ /super: MRR · เงินที่ร้านเติมเดือนนี้ · ยอดที่ใช้จากกระเป๋า · ยอดคงเหลือ
const GET = superRoute((_c, _i, user) => revenueReport(user.id), { read: true });

module.exports = { GET };
