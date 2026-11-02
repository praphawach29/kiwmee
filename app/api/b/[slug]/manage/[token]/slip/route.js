const { getParams, json, route } = require("../../../../../../../src/http");
const { sameOrigin } = require("../../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../../src/v2/db");
const { submitSlip } = require("../../../../../../../src/v2/manage-booking");
const { readImage, sanitizeImage } = require("../../../../../../../src/v2/media-upload");
const { clientKey, rateLimit } = require("../../../../../../../src/v2/public-booking");

// The customer's transfer slip: a raw JPEG/PNG/WebP body. It is decoded and re-encoded (no metadata,
// at most 1600 px) before it reaches the database, where only the shop's members can read it.
async function POST(request, context) {
  return route(async () => {
    sameOrigin(request);
    const { slug, token } = await getParams(context);
    const db = getBookingPool();
    await rateLimit(db, clientKey(request), "slip", 10, 600);
    const { bytes, mime } = await readImage(request);
    const image = await sanitizeImage(bytes, mime, { maxSide: 1600, maxBytes: 1500 * 1024 });
    return json(await submitSlip(db, slug, token, image));
  });
}

const runtime = "nodejs";
module.exports = { POST, runtime };
