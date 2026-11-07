// LIFF opens its endpoint URL (https://kiwmee.up.railway.app/b) with the rest of the LIFF link in
// ?liff.state= — https://liff.line.me/<liffId>/bloom-hair arrives as /b?liff.state=%2Fbloom-hair.
// This turns that into the page to show: a shop's booking page, a booking's own link, or the
// customer's bookings at that shop (/me), nothing else.
export function liffTarget(state) {
  if (typeof state !== "string" || state.length > 200) return null;
  let path = state;
  try {
    path = decodeURIComponent(state);
  } catch {
    return null;
  }
  path = path.split(/[?#]/)[0].replace(/\/+$/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.startsWith("/b/")) path = path.slice(2); // a LIFF link that repeats /b
  const match = /^\/([a-z0-9][a-z0-9-]{1,40})(\/manage\/[A-Za-z0-9_-]{32}|\/me|\/services|\/review(?:\/[A-Za-z0-9_-]+)?|\/line-preview)?$/.exec(path);
  return match ? `/b/${match[1]}${match[2] ?? ""}` : null;
}

// Where /b sends the customer: the target page, keeping every other query parameter. Signing in with
// LINE in a browser (not inside LINE) comes back here as /b?liff.state=…&code=…&state=…&liffClientId=…
// &liffRedirectUri=… — the LIFF SDK on the shop's page needs those to finish signing in, so dropping
// them left the customer signed out after scanning LINE's QR code.
export function liffRedirect(params = {}) {
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const target = liffTarget(pick(params["liff.state"]));
  if (!target) return "/";
  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "liff.state") continue;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") rest.append(key, v);
  }
  const query = rest.toString();
  return query ? `${target}?${query}` : target;
}
