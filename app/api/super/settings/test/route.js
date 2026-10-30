const { json } = require("../../../../../src/http");
const { sameOrigin } = require("../../../../../src/security/limits");
const { adminRoute } = require("../../../../../src/v2/admin-auth");
const { asUser } = require("../../../../../src/v2/admin-catalog");
const { getBookingPool } = require("../../../../../src/v2/db");
const { isPlatformAdmin, testMessagingToken } = require("../../../../../src/v2/platform-settings");
const { forbidden } = require("../../../../../src/errors");

// Asks LINE whether the saved Messaging API channel access token works (platform admins only)
async function POST(request) {
  return adminRoute(request, async (user) => {
    sameOrigin(request);
    const pool = getBookingPool();
    if (!(await asUser(pool, user, (client) => isPlatformAdmin(client)))) throw forbidden("เฉพาะผู้ดูแลแพลตฟอร์มเท่านั้น");
    return json(await testMessagingToken(pool));
  });
}

module.exports = { POST };
