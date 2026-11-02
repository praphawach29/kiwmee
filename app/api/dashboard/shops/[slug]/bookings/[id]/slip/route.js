const { getParams } = require("../../../../../../../../src/http");
const { notFound } = require("../../../../../../../../src/errors");
const { adminRoute } = require("../../../../../../../../src/v2/admin-auth");
const { asUser, memberShop } = require("../../../../../../../../src/v2/admin-catalog");
const { getSlip } = require("../../../../../../../../src/v2/admin-bookings");
const { getBookingPool } = require("../../../../../../../../src/v2/db");

// The customer's transfer slip as an image (?n=1 for the one before), for the shop's members only.
// Never cached: it is a customer's bank record.
async function GET(request, context) {
  return adminRoute(request, async (user) => {
    const { slug, id } = await getParams(context);
    const n = new URL(request.url).searchParams.get("n");
    const slip = await asUser(getBookingPool(), user, async (client) => getSlip(client, await memberShop(client, slug), id, n));
    if (!slip) throw notFound("ยังไม่มีสลิป");
    return new Response(slip.image, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
        "x-slip-count": String(slip.total)
      }
    });
  });
}

const runtime = "nodejs";
module.exports = { GET, runtime };
