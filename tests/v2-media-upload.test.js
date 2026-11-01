const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const media = require('../src/v2/media-upload');
const PROJECT = 'https://ezubgqeqdipwfnmorqkj.supabase.co';
const SHOP = 'b1000000-0000-4000-8000-000000000001';

test('accepts real JPEG and WebP, discards appended payload, and generates a new name every time', async () => {
  const urls = [];
  for (const [format, mime] of [['jpeg','image/jpeg'], ['webp','image/webp']]) {
    const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc' } })[format]().toBuffer();
    let stored;
    const result = await media.uploadImage(new Request('https://app.test/upload', { method: 'POST', headers: { 'content-type': mime }, body: Buffer.concat([input, Buffer.from('<script>untrusted trailing payload</script>')]) }), { id: SHOP }, { accessToken: 'user-token' }, { config: { url: PROJECT, key: 'sb_publishable_test' }, fetchImpl: async (_url, init) => { stored = init.body; return Response.json({}); } });
    assert.equal(stored.includes(Buffer.from('<script>')), false);
    assert.equal((await sharp(stored).metadata()).format, 'webp');
    urls.push(result.url);
  }
  assert.notEqual(urls[0], urls[1]);
});

test('decodes and sanitizes a real PNG to metadata-free WebP under a random business path', async () => {
  const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().withMetadata().toBuffer();
  let stored;
  const request = new Request('https://app.test/api/dashboard/shops/test/media', { method: 'POST', headers: { 'content-type': 'image/png' }, body: source });
  const result = await media.uploadImage(request, { id: SHOP }, { accessToken: 'user-token' }, {
    config: { url: PROJECT, key: 'sb_publishable_test' },
    fetchImpl: async (url, init) => { stored = { url, init }; return Response.json({ Key: 'ok' }); }
  });
  assert.match(stored.url, new RegExp(`^${PROJECT}/storage/v1/object/shop-media/${SHOP}/[0-9a-f-]{36}\\.webp$`));
  assert.equal(stored.init.headers.authorization, 'Bearer user-token');
  assert.equal(stored.init.headers['x-upsert'], 'false');
  assert.equal(stored.init.headers['content-type'], 'image/webp');
  const metadata = await sharp(stored.init.body).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.exif, undefined);
  assert.deepEqual(result, { url: stored.url.replace('/object/', '/object/public/'), alt: '' });
});
