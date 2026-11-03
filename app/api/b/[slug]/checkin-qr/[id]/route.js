const QRCode = require("qrcode");
const { getParams } = require("../../../../../../src/http");
const { scanUrl, publicOrigin, UUID } = require("../../../../../../src/v2/scan-codes");

// The check-in QR as a PNG, for the LINE reminder card (LINE fetches card images by URL).
// It only draws what the URL already says — the booking's id — and never reads the database, so it
// tells nobody whether a booking exists; the id opens nothing outside the shop's own dashboard.
async function GET(request, context) {
  const { slug, id } = await getParams(context);
  if (!/^[a-z0-9-]{1,64}$/.test(slug) || !UUID.test(id)) return new Response("not found", { status: 404 });
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const png = await QRCode.toBuffer(scanUrl(origin, slug, "b", id), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
    color: { dark: "#1B1640", light: "#FFFFFF" }
  });
  return new Response(png, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }
  });
}

module.exports = { GET };
