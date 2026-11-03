const { getParams, json, route } = require("../../../../../../../src/http");
const { sameOrigin } = require("../../../../../../../src/security/limits");
const { getBookingPool } = require("../../../../../../../src/v2/db");
const { submitSlip } = require("../../../../../../../src/v2/manage-booking");
const { readImage, sanitizeImage } = require("../../../../../../../src/v2/media-upload");
const { clientKey, rateLimit } = require("../../../../../../../src/v2/public-booking");
const { lineCard } = require("../../../../../../../src/v2/admin-bookings");
const { pushLine } = require("../../../../../../../src/v2/line-notify");
const { findShop } = require("../../../../../../../src/v2/catalog-repository");
const sharp = require("sharp");

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
    // the slip-reading service takes JPEG (only when a key is set does it leave this server)
    const jpeg = await sharp(image).jpeg({ quality: 90 }).toBuffer();
    // a slip that confirmed the deposit by itself: the customer hears it in LINE, as when the shop confirms
    const onConfirmed = async (bookingId) => {
      const shop = await findShop(db, slug);
      const message = await lineCard(db, shop, bookingId, "confirmed");
      if (message) await pushLine(db, message.to, [message.card]);
    };
    return json(await submitSlip(db, slug, token, image, { jpeg, onConfirmed }));
  });
}

const runtime = "nodejs";
module.exports = { POST, runtime };
