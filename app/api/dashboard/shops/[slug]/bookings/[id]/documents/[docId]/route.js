const { getParams } = require("../../../../../../../../../src/http");
const { adminRoute } = require("../../../../../../../../../src/v2/admin-auth");
const { asUser, memberShop } = require("../../../../../../../../../src/v2/admin-catalog");
const { shopRoute } = require("../../../../../../../../../src/v2/admin-routes");
const { readDocument, deleteDocument } = require("../../../../../../../../../src/v2/rental-documents");
const { getBookingPool } = require("../../../../../../../../../src/v2/db");

// One document picture, decrypted, for the shop's members only. Never cached or indexed: it is a
// customer's ID (PDPA).
async function GET(request, context) {
  return adminRoute(request, async (user) => {
    const { slug, docId } = await getParams(context);
    const doc = await asUser(getBookingPool(), user, async (client) => readDocument(client, await memberShop(client, slug), docId));
    return new Response(doc.image, {
      headers: {
        "content-type": doc.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
        "content-disposition": "inline"
      }
    });
  });
}

// Delete it now (before its date)
const DELETE = shopRoute((client, shop, body, { docId }) => deleteDocument(client, shop, docId), { owner: false, body: false });

const runtime = "nodejs";
module.exports = { GET, DELETE, runtime };
