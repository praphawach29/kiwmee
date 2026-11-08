const { json, route } = require("../../../../src/http");
const { boundedJson } = require("../../../../src/security/limits");
const { getBookingPool } = require("../../../../src/v2/db");
const { clientKey, rateLimit, verifyLineIdToken } = require("../../../../src/v2/public-booking");
const { finishLink } = require("../../../../src/v2/owner-notices");

// หน้าใน LINE (/b/owner-line/<code>) ผูกบัญชี LINE ของเจ้าของร้านกับแดชบอร์ด: body = { code, lineIdToken }
async function POST(request) {
  return route(async () => {
    const body = await boundedJson(request);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "owner-link", 20, 600);
    return json(await finishLink(db, body, { verifyLineToken: (token) => verifyLineIdToken(token, db) }));
  });
}

module.exports = { POST };
