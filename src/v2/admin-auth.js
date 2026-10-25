// Shop admin sign-in with Supabase Auth (design §3, step 5).
//
// The browser signs in with Supabase Auth directly (so Supabase's per-IP limits count each owner,
// not our server) and hands the session to POST /api/dashboard/session, which checks it with
// Supabase and keeps it in httpOnly cookies. Every admin request then:
//   1. reads the cookies, refreshing the access token when it has expired
//   2. asks Supabase who the token belongs to (cached for a minute)
//   3. runs its queries as role `authenticated` with that user's id (admin-catalog.js asMember),
//      so the RLS policies of step 1 decide what the user may read and change.
//
// SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_PUBLISHABLE_KEY (or the legacy anon key in
// SUPABASE_ANON_KEY) must be set. The key is public; the page passes it to the browser.

const { AppError } = require("../errors");
const { jsonError } = require("../http");

const ACCESS_COOKIE = "bk_access";
const REFRESH_COOKIE = "bk_refresh";
const REFRESH_MAX_AGE = 30 * 24 * 3600;
const USER_CACHE_MS = 60 * 1000;

function authConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function requireConfig() {
  const config = authConfig();
  if (!config) throw new AppError("NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY", 503);
  return config;
}

const unauthorized = () => new AppError("UNAUTHORIZED", "กรุณาเข้าสู่ระบบ", 401);

// Only to decide when to refresh; the token itself is checked by Supabase in fetchUser
function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const userCache = new Map();

async function fetchUser(token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = userCache.get(token);
  if (cached && cached.until > now) return cached.user;
  const { url, key } = requireConfig();
  const response = await fetchImpl(`${url}/auth/v1/user`, {
    headers: { apikey: key, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new AppError("AUTH_UNAVAILABLE", "ระบบล็อกอินขัดข้อง กรุณาลองใหม่", 503);
  const body = await response.json();
  if (!body?.id) return null;
  const user = { id: body.id, email: body.email ?? null };
  if (userCache.size > 1000) userCache.clear();
  userCache.set(token, { user, until: Math.min(now + USER_CACHE_MS, tokenExpiresAt(token) || now) });
  return user;
}

async function refreshSession(refreshToken, { fetchImpl = fetch } = {}) {
  const { url, key } = requireConfig();
  const response = await fetchImpl(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(5000)
  });
  if (response.status >= 400 && response.status < 500) return null;
  if (!response.ok) throw new AppError("AUTH_UNAVAILABLE", "ระบบล็อกอินขัดข้อง กรุณาลองใหม่", 503);
  const body = await response.json();
  return body?.access_token && body?.refresh_token ? { accessToken: body.access_token, refreshToken: body.refresh_token } : null;
}

async function signOut(accessToken, { fetchImpl = fetch } = {}) {
  const config = authConfig();
  if (!config || !accessToken) return;
  userCache.delete(accessToken);
  await fetchImpl(`${config.url}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: config.key, authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(request) {
  return request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || new URL(request.url).protocol === "https:";
}

function sessionCookies(request, session) {
  const flags = `HttpOnly; SameSite=Lax; Path=/${isSecure(request) ? "; Secure" : ""}`;
  if (!session) return [`${ACCESS_COOKIE}=; ${flags}; Max-Age=0`, `${REFRESH_COOKIE}=; ${flags}; Max-Age=0`];
  return [
    `${ACCESS_COOKIE}=${encodeURIComponent(session.accessToken)}; ${flags}; Max-Age=${REFRESH_MAX_AGE}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(session.refreshToken)}; ${flags}; Max-Age=${REFRESH_MAX_AGE}`
  ];
}

/**
 * The signed-in user for this request, or null. `cookies` holds Set-Cookie values the response must
 * carry (a refreshed session, or clearing a dead one).
 */
async function currentUser(request, options = {}) {
  const now = options.now ?? Date.now();
  const cookies = readCookies(request);
  let access = cookies[ACCESS_COOKIE];
  const refresh = cookies[REFRESH_COOKIE];
  if (!access && !refresh) return { user: null, cookies: [] };

  let refreshed = null;
  if (refresh && (!access || tokenExpiresAt(access) - 30000 < now)) {
    refreshed = await refreshSession(refresh, options);
    if (!refreshed) return { user: null, cookies: sessionCookies(request, null) };
    access = refreshed.accessToken;
  }
  const user = access ? await fetchUser(access, options) : null;
  if (!user) return { user: null, cookies: sessionCookies(request, null) };
  return { user, cookies: refreshed ? sessionCookies(request, refreshed) : [] };
}

/**
 * A route handler for signed-in users: runs handler(user), answers 401 without a session, turns
 * errors into the usual JSON error, and adds any session cookies to whatever goes back.
 */
async function adminRoute(request, handler, options) {
  let cookies = [];
  let response;
  try {
    const session = await currentUser(request, options);
    cookies = session.cookies;
    if (!session.user) throw unauthorized();
    response = await handler(session.user);
  } catch (error) {
    response = jsonError(error);
  }
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

/** A session the browser got from Supabase Auth: checked with Supabase before we keep it. */
async function acceptSession(request, body, options = {}) {
  const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
  const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
  if (!accessToken || !refreshToken || accessToken.length > 4096 || refreshToken.length > 512) throw unauthorized();
  const user = await fetchUser(accessToken, options);
  if (!user) throw unauthorized();
  return { user, cookies: sessionCookies(request, { accessToken, refreshToken }) };
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  authConfig,
  currentUser,
  adminRoute,
  acceptSession,
  signOut,
  readCookies,
  sessionCookies,
  tokenExpiresAt,
  _userCache: userCache
};
