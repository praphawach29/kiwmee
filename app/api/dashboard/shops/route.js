const { json } = require("../../../../src/http");
const { boundedJson } = require("../../../../src/security/limits");
const { adminRoute } = require("../../../../src/v2/admin-auth");
const { asUser, createShop, listShops } = require("../../../../src/v2/admin-catalog");
const { getBookingPool } = require("../../../../src/v2/db");

// The shops the signed-in user belongs to
async function GET(request) {
  return adminRoute(request, async (user) => json(await asUser(getBookingPool(), user, listShops)));
}

// A new shop, owned by the signed-in user: { name, slug, kind }
async function POST(request) {
  return adminRoute(request, async (user) => {
    const body = await boundedJson(request);
    return json(await asUser(getBookingPool(), user, (client) => createShop(client, body)), 201);
  });
}

module.exports = { GET, POST };
