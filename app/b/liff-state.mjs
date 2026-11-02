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
  const match = /^\/([a-z0-9][a-z0-9-]{1,40})(\/manage\/[A-Za-z0-9_-]{32}|\/me)?$/.exec(path);
  return match ? `/b/${match[1]}${match[2] ?? ""}` : null;
}
