// Shop admin sign-in (src/v2/admin-auth.js) with Supabase Auth replaced by a fake fetch.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://example.supabase.co/";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
const auth = require("../src/v2/admin-auth");

const NOW = Date.parse("2026-10-25T10:00:00Z");
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ sub: "u1", exp: Math.floor(exp / 1000) })).toString("base64url")}.s`;
const LIVE = jwt(NOW + 3600 * 1000);
const EXPIRED = jwt(NOW - 1000);
const USER = { id: "e1000000-0000-4000-8000-000000000001", email: "owner@test.local" };

function request(cookies = {}, url = "https://shop.example/api/dashboard/shops") {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function fakeSupabase({ users = { [LIVE]: USER }, refresh = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    assert.equal(init.headers.apikey, "sb_publishable_test");
    if (url.endsWith("/auth/v1/user")) {
      const user = users[init.headers.authorization.replace("Bearer ", "")];
      return user ? Response.json(user) : Response.json({ msg: "bad jwt" }, { status: 401 });
    }
    if (url.endsWith("/auth/v1/token?grant_type=refresh_token")) {
      const next = refresh[JSON.parse(init.body).refresh_token];
      return next ? Response.json(next) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

test.beforeEach(() => auth._userCache.clear());

test("no cookies: nobody, and nothing asked of Supabase", async () => {
  const { fetchImpl, calls } = fakeSupabase();
  assert.deepEqual(await auth.currentUser(request(), { fetchImpl, now: NOW }), { user: null, cookies: [] });
  assert.equal(calls.length, 0);
});

test("a live access token is checked with Supabase once, then cached", async () => {
  const { fetchImpl, calls } = fakeSupabase();
  const req = request({ bk_access: LIVE, bk_refresh: "r1" });
  assert.deepEqual(await auth.currentUser(req, { fetchImpl, now: NOW }), { user: USER, cookies: [] });
  assert.deepEqual(await auth.currentUser(req, { fetchImpl, now: NOW + 1000 }), { user: USER, cookies: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co/auth/v1/user");
});

test("an expired access token is refreshed and the new session goes back as cookies", async () => {
  const { fetchImpl, calls } = fakeSupabase({ refresh: { r1: { access_token: LIVE, refresh_token: "r2" } } });
  const { user, cookies } = await auth.currentUser(request({ bk_access: EXPIRED, bk_refresh: "r1" }), { fetchImpl, now: NOW });
  assert.deepEqual(user, USER);
  assert.equal(calls[0].url, "https://example.supabase.co/auth/v1/token?grant_type=refresh_token");
  assert.match(cookies[0], /^bk_access=h\.[^;]+; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=\d+$/);
  assert.match(cookies[1], /^bk_refresh=r2; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=\d+$/);
});

test("a revoked refresh token or a forged access token signs the browser out", async () => {
  const { fetchImpl } = fakeSupabase();
  const revoked = await auth.currentUser(request({ bk_access: EXPIRED, bk_refresh: "gone" }), { fetchImpl, now: NOW });
  assert.equal(revoked.user, null);
  assert.deepEqual(revoked.cookies.map((c) => c.split(";")[0]), ["bk_access=", "bk_refresh="]);

  const forged = jwt(NOW + 3600 * 1000).replace(".s", ".forged");
  const result = await auth.currentUser(request({ bk_access: forged, bk_refresh: "r1" }), { fetchImpl, now: NOW });
  assert.equal(result.user, null);
  assert.match(result.cookies[0], /Max-Age=0/);
});

test("adminRoute: 401 without a session, the handler's response with one", async () => {
  const { fetchImpl } = fakeSupabase();
  const denied = await auth.adminRoute(request(), async () => Response.json({ ok: true }), { fetchImpl, now: NOW });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "UNAUTHORIZED");

  const ok = await auth.adminRoute(request({ bk_access: LIVE, bk_refresh: "r1" }), async (user) => Response.json({ id: user.id }), { fetchImpl, now: NOW });
  assert.deepEqual(await ok.json(), { id: USER.id });
});

test("a session handed over by the browser is kept only if Supabase knows it", async () => {
  const { fetchImpl } = fakeSupabase();
  const accepted = await auth.acceptSession(request({}, "http://localhost:3000/api/dashboard/session"), { accessToken: LIVE, refreshToken: "r1" }, { fetchImpl, now: NOW });
  assert.deepEqual(accepted.user, USER);
  assert.ok(!accepted.cookies[0].includes("Secure"), "plain http in development");
  await assert.rejects(auth.acceptSession(request(), { accessToken: "nope", refreshToken: "r1" }, { fetchImpl, now: NOW }), (e) => e.status === 401);
  await assert.rejects(auth.acceptSession(request(), { accessToken: LIVE }, { fetchImpl, now: NOW }), (e) => e.status === 401);
});
