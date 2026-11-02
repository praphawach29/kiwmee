// "นำทาง" to the shop (migration …002500): the shop's own map link (pasted from Google Maps or Apple
// Maps) when it has one, else a Google Maps search for its address. Only map sites are accepted, so a
// shop cannot point its customers somewhere else.

const MAP_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|goo\.gl|apple\.com)$/i;

/** A map link the shop may save: https on a map site, or null when it is not one */
function validMapUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !MAP_HOST.test(url.hostname)) return null;
    if (url.toString().length > 500) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Where the "นำทาง" button goes, or null when the shop gave neither a link nor an address */
function directionsLink({ address, mapUrl } = {}) {
  const link = validMapUrl(mapUrl);
  if (link) return link;
  const place = typeof address === "string" ? address.trim() : "";
  return place ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}` : null;
}

module.exports = { validMapUrl, directionsLink };
