const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const media = require('../src/v2/media-upload');
const auth = require('../src/v2/admin-auth');
const { AppError } = require('../src/errors');
const SHOP = 'b1000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-25T10:00:00Z');
const token = (expires) => `h.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString('base64url')}.s`;
const LIVE = token(NOW + 3600000);
const EXPIRED = token(NOW - 1000);
const USER = { id: 'ef000000-0000-4000-8000-000000000001', email: 'owner@test.local' };
const config = { url: 'https://ezubgqeqdipwfnmorqkj.supabase.co', key: 'sb_publishable_test' };
process.env.SUPABASE_URL = config.url;
process.env.SUPABASE_PUBLISHABLE_KEY = config.key;
const png = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
const req = (body, type = 'image/png', headers = {}) => new Request('https://app.test/api/dashboard/shops/test/media', { method: 'POST', body, headers: { 'content-type': type, ...headers } });

function routeHarness({ role = 'owner', member = true, cookies = `bk_access=${LIVE}`, failStorage = false, origin, limited = false } = {}) {
  const queries = [], calls = [];
  let read = false;
  const client = { release() {}, async query(sql) { queries.push(sql); return { rows: sql.includes('join public.business_members') && member ? [{ id: SHOP, role }] : [] }; } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/auth/v1/token')) return Response.json({ access_token: LIVE, refresh_token: 'new-refresh' });
    if (url.includes('/auth/v1/user')) return Response.json(USER);
    return Response.json({}, { status: failStorage ? 403 : 200 });
  };
  const handler = media.mediaUploadRoute({ config, fetchImpl, getPool: () => ({ connect: async () => client }), authOptions: { fetchImpl, now: NOW }, limiter: { consume() { if (limited) throw new AppError('RATE_LIMITED', 'slow down', 429); } } });
  return { queries, calls, async run() {
    auth._userCache.clear();
    const bytes = await png();
    const request = { url: 'https://app.test/api/dashboard/shops/test/media', headers: new Headers({ cookie: cookies, 'content-type': 'image/png', ...(origin ? { origin } : {}) }), get body() { read = true; return new Blob([bytes]).stream(); } };
    const response = await handler(request, { params: Promise.resolve({ slug: 'test' }) });
    return { response, body: await response.json(), read };
  } };
}

test('denies anonymous, staff, nonmembers, rate limit and foreign origins before reading or storage', async () => {
  for (const [options, status] of [[{ cookies: '' }, 401], [{ role: 'staff' }, 403], [{ member: false }, 404], [{ origin: 'https://evil.test' }, 403], [{ limited: true }, 429]]) {
    const harness = routeHarness(options);
    const result = await harness.run();
    assert.equal(result.response.status, status);
    assert.equal(result.read, false);
    assert.equal(harness.calls.filter(c => c.url.includes('/storage/')).length, 0);
  }
});

test('uses refreshed JWT for storage and returns only media plus refresh cookies', async () => {
  const harness = routeHarness({ cookies: `bk_access=${EXPIRED}; bk_refresh=old` });
  const { response, body } = await harness.run();
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(body.data).sort(), ['alt', 'url']);
  assert.match(response.headers.get('set-cookie'), /bk_refresh=new-refresh/);
  assert.equal(harness.calls.find(c => c.url.includes('/storage/')).init.headers.authorization, `Bearer ${LIVE}`);
  assert.ok(harness.queries.includes('set local role authenticated'));
  assert.ok(harness.queries.includes('commit'));
});

test('storage refusal becomes safe 503, not success or provider error leakage', async () => {
  const { response, body } = await routeHarness({ failStorage: true }).run();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'MEDIA_UNAVAILABLE');
});

test('rejects invalid MIME, mismatch, malformed magic, corrupt image and size before storage', async () => {
  let calls = 0;
  const options = { config, fetchImpl: async () => { calls++; return Response.json({}); } };
  const good = await png();
  for (const [request, status] of [[req(good, 'image/svg+xml'), 415], [req(good, 'image/jpeg'), 422], [req(Buffer.from('<svg/>')), 422], [req(good.subarray(0, 20)), 422], [req(Buffer.alloc(0)), 422], [req(good, 'image/png', { 'content-length': String(media.MAX_BYTES + 1) }), 413], [req(Buffer.alloc(media.MAX_BYTES + 1)), 413]]) {
    await assert.rejects(media.uploadImage(request, { id: SHOP }, { accessToken: LIVE }, options), e => e.status === status);
  }
  assert.equal(calls, 0);
});

test('streaming cap cancels chunked upload without trusting content-length', async () => {
  let cancelled = false;
  const request = { headers: new Headers({ 'content-type': 'image/png' }), body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(media.MAX_BYTES + 1)); }, cancel() { cancelled = true; } }) };
  await assert.rejects(media.uploadImage(request, { id: SHOP }, { accessToken: LIVE }, { config }), e => e.status === 413);
  assert.equal(cancelled, true);
});

test('rejects over-25MP input before decoding or storage', async () => {
  const huge = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(media.uploadImage(req(huge), { id: SHOP }, { accessToken: LIVE }, { config }), e => e.status === 422);
});

test('rejects animated WebP rather than storing a frame', async () => {
  const pixels = Buffer.concat([Buffer.alloc(2 * 2 * 3, 0), Buffer.alloc(2 * 2 * 3, 255)]);
  const animation = await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100,100] }).toBuffer();
  assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
  await assert.rejects(media.uploadImage(req(animation, 'image/webp'), { id: SHOP }, { accessToken: LIVE }, { config }), e => e.status === 422);
});

test('rejects APNG animation control even when the decoder exposes only its first frame', async () => {
  const source = await png();
  // Animation marker chunk after IHDR. CRC is irrelevant: it must be refused before decoding.
  const marker = Buffer.from('000000086163544c000000020000000000000000', 'hex');
  const apng = Buffer.concat([source.subarray(0,33), marker, source.subarray(33)]);
  await assert.rejects(media.uploadImage(req(apng), { id: SHOP }, { accessToken: LIVE }, { config, fetchImpl: async () => Response.json({}) }), e => e.status === 422);
});

test('fails closed on wrong project, service key, absent JWT and network errors', async () => {
  for (const bad of [{ ...config, url: 'https://wrong.supabase.co' }, { ...config, key: 'sb_secret_bad' }, { ...config, key: `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s` }]) {
    await assert.rejects(media.uploadImage(req(await png()), { id: SHOP }, { accessToken: LIVE }, { config: bad }), e => e.status === 503);
  }
  await assert.rejects(media.uploadImage(req(await png()), { id: SHOP }, {}, { config }), e => e.status === 401);
  await assert.rejects(media.uploadImage(req(await png()), { id: SHOP }, { accessToken: LIVE }, { config, fetchImpl: async () => { throw new Error('provider secret'); } }), e => e.status === 503 && !e.message.includes('secret'));
});
