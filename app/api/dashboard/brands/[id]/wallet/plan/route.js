const { brandRoute } = require("../../../../../../../src/v2/admin-routes");
const { setPlanOptions } = require("../../../../../../../src/v2/wallet");

// การต่ออายุของแพ็กเกจ: body = { autoRenew, nextPlan, nextCycle } (ไม่ตัดเงิน)
const PUT = brandRoute((client, body, params, user) => setPlanOptions(params.id, user.id, body ?? {}));

module.exports = { PUT };
