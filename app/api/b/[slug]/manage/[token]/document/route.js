const { getParams, json, route } = require("../../../../../../../src/http");
const { sameOrigin } = require("../../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../../src/v2/db");
const { submitManagedDocument } = require("../../../../../../../src/v2/manage-booking");
const { readImage, sanitizeImage } = require("../../../../../../../src/v2/media-upload");
const { clientKey, rateLimit } = require("../../../../../../../src/v2/public-booking");

// The customer's rental document (?kind=id_card|driving_license|passport&consent=yes): a raw
// JPEG/PNG/WebP body, decoded and re-encoded (no EXIF/GPS, at most 2000 px), then encrypted before it
// is stored (src/v2/rental-documents.js). Without consent=yes nothing is kept.
async function POST(request, context) {
  return route(async () => {
    sameOrigin(request);
    const { slug, token } = await getParams(context);
    const query = new URL(request.url).searchParams;
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "document", 10, 600);
    const { bytes, mime } = await readImage(request);
    const image = await sanitizeImage(bytes, mime, { maxSide: 2000, maxBytes: 1500 * 1024 });
    return json(await submitManagedDocument(db, slug, token, { kind: query.get("kind"), consent: query.get("consent") === "yes", image }));
  });
}

const runtime = "nodejs";
module.exports = { POST, runtime };
