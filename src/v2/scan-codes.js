// What the QR codes carry (check-in at the desk):
//   booking  → https://<host>/dashboard/<slug>?scan=b-<booking id>
//   member   → https://<host>/dashboard/<slug>?scan=m-<6-digit member code, good for 10 minutes>
// A phone's own camera opens the link straight into the shop's dashboard (sign-in needed); the
// scanner inside the dashboard reads the same text. Neither gives a customer's rights to anyone:
// the booking id opens nothing outside the shop's dashboard, and the member code runs out.
// Staff can also type the 8-character booking code printed under the QR, or the 6 digits.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function scanUrl(origin, slug, kind, value) {
  return `${origin}/dashboard/${encodeURIComponent(slug)}?scan=${kind}-${value}`;
}

const bookingCode = (id) => String(id).slice(0, 8).toUpperCase();

/** Whatever was scanned or typed → { kind: "booking", ref } | { kind: "member", code } | null */
function parseScan(text) {
  let value = String(text ?? "").trim();
  try {
    const url = new URL(value);
    value = url.searchParams.get("scan") ?? "";
  } catch {
    // not a link: the raw value, or what staff typed
  }
  value = value.replace(/\s+/g, "").toLowerCase();
  const tagged = /^([bm])-(.+)$/.exec(value);
  const body = tagged ? tagged[2] : value;
  if ((!tagged || tagged[1] === "b") && (UUID.test(body) || /^[0-9a-f]{8}$/.test(body)) && !/^\d{6}$/.test(body)) return { kind: "booking", ref: body };
  if ((!tagged || tagged[1] === "m") && /^\d{6}$/.test(body)) return { kind: "member", code: body };
  return null;
}

module.exports = { scanUrl, bookingCode, parseScan };
