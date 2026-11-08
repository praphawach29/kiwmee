const { superRoute } = require("../../../../src/v2/admin-routes");
const { brandAction } = require("../../../../src/v2/platform-plans");

// /super → แบรนด์และแพ็กเกจ: ดูรายละเอียด ตั้งแพ็กเกจ ปรับยอดกระเป๋า (เฉพาะผู้ดูแลแพลตฟอร์ม · บันทึกเหตุผลทุกครั้ง)
const POST = superRoute((client, body, user) => brandAction(user.id, body ?? {}));

module.exports = { POST };
