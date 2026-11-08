const { userRoute } = require("../../../../src/v2/admin-routes");
const { linkAction } = require("../../../../src/v2/owner-notices");

// แจ้งเตือนเจ้าของร้านทาง LINE (B8): body = { action: "status" | "start" | "unlink" | "test" }
const POST = userRoute((body, user) => linkAction(user.id, body));

module.exports = { POST };
