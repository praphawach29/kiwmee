const { json, route } = require("../../../../src/http");
const { boundedJson, sameOrigin } = require("../../../../src/security/limits");
const { acceptSession, currentUser, readCookies, sessionCookies, signOut, ACCESS_COOKIE } = require("../../../../src/v2/admin-auth");
const { getBookingPool } = require("../../../../src/v2/db");
const { clientKey, rateLimit } = require("../../../../src/v2/public-booking");

// Who is signed in (null when nobody)
async function GET(request) {
  return route(async () => {
    const { user, cookies } = await currentUser(request);
    const response = json({ user });
    for (const cookie of cookies) response.headers.append("set-cookie", cookie);
    return response;
  });
}

// The browser signed in with Supabase Auth and hands over the session: { accessToken, refreshToken }
async function POST(request) {
  return route(async () => {
    const body = await boundedJson(request);
    await rateLimit(getBookingPool(), clientKey(request), "admin-session", 20, 600);
    const { user, cookies } = await acceptSession(request, body);
    const response = json({ user });
    for (const cookie of cookies) response.headers.append("set-cookie", cookie);
    return response;
  });
}

async function DELETE(request) {
  return route(async () => {
    sameOrigin(request);
    await signOut(readCookies(request)[ACCESS_COOKIE]);
    const response = json({ user: null });
    for (const cookie of sessionCookies(request, null)) response.headers.append("set-cookie", cookie);
    return response;
  });
}

module.exports = { GET, POST, DELETE };
