// Server-only: raw JPEG/PNG/WebP -> decoded, metadata-free WebP -> Supabase Storage.
// Never fetch a merchant-supplied URL and never use a service-role credential.
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { AppError } = require('../errors');
const { getParams, json } = require('../http');
const { sameOrigin, MemoryRateLimiter } = require('../security/limits');
const { authConfig, adminRoute } = require('./admin-auth');
const { asUser, memberShop } = require('./admin-catalog');
const { getBookingPool } = require('./db');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 25 * 1000 * 1000;
const PROJECT_URL = 'https://ezubgqeqdipwfnmorqkj.supabase.co';
const BUCKET = 'shop-media';
const MIME_FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uploadLimiter = new MemoryRateLimiter({ max: 12, windowMs: 60000 });
const invalid = () => new AppError('INVALID_IMAGE', 'กรุณาเลือกไฟล์รูป JPEG, PNG หรือ WebP ที่สมบูรณ์', 422);
const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', 'รูปภาพต้องมีขนาดไม่เกิน 5 MB', 413);
const unavailable = () => new AppError('MEDIA_UNAVAILABLE', 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่', 503);

function storageConfig(config = authConfig()) {
  if (!config || config.url.replace(/\/+$/, '') !== PROJECT_URL) {
    throw new AppError('NOT_CONFIGURED', 'ต้องตั้งค่า Storage เป็นโปรเจกต์ booking-v2 เท่านั้น', 503);
  }
  // Only public API credentials: a publishable key or the old anon JWT, never a secret key.
  let anon = false;
  try { anon = JSON.parse(Buffer.from(config.key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch {}
  if (!config.key?.startsWith('sb_publishable_') && !anon) {
    throw new AppError('NOT_CONFIGURED', 'Storage ต้องใช้ publishable หรือ anon key เท่านั้น', 503);
  }
  return { url: PROJECT_URL, key: config.key };
}

async function readImage(request) {
  const mime = (request.headers.get('content-type') || '').trim().toLowerCase();
  if (!MIME_FORMATS[mime]) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'รองรับเฉพาะไฟล์ JPEG, PNG หรือ WebP แบบ binary', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  } finally { reader.releaseLock(); }
  if (!size) throw invalid();
  return { bytes: Buffer.concat(chunks, size), mime };
}

function magicFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function sanitizeImage(bytes, mime) {
  if (magicFormat(bytes) !== MIME_FORMATS[mime]) throw invalid();
  // libvips may expose APNG as a still PNG, so inspect the real chunk structure too.
  if (mime === 'image/png') {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (length > bytes.length - offset - 12 || type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw invalid();
      offset += length + 12;
      if (type === 'IEND') break;
    }
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    if (metadata.format !== MIME_FORMATS[mime] || (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw invalid();
    // sharp drops EXIF/XMP/ICC by default; full decode + re-encode also discards appended payloads.
    const output = await image.rotate().webp({ quality: 85 }).toBuffer();
    if (output.length > MAX_BYTES) throw tooLarge();
    return output;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}

async function uploadImage(request, shop, session, { config, fetchImpl = fetch } = {}) {
  const { url, key } = storageConfig(config);
  if (!session?.accessToken) throw new AppError('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
  if (!UUID.test(shop?.id || '')) throw invalid();
  const { bytes, mime } = await readImage(request);
  const output = await sanitizeImage(bytes, mime);
  const objectPath = `${BUCKET}/${shop.id}/${randomUUID()}.webp`;
  let response;
  try {
    response = await fetchImpl(`${url}/storage/v1/object/${objectPath}`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${session.accessToken}`, 'content-type': 'image/webp', 'x-upsert': 'false', 'cache-control': '31536000' },
      body: output,
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw unavailable(); }
  if (!response.ok) throw unavailable();
  return { url: `${url}/storage/v1/object/public/${objectPath}`, alt: '' };
}

// Auth and owner membership complete before any image bytes are read or decoded.
function mediaUploadRoute(options = {}) {
  return (request, context) => adminRoute(request, async (user, session) => {
    sameOrigin(request);
    const params = await getParams(context);
    const shop = await asUser((options.getPool || getBookingPool)(), user, (client) => memberShop(client, params.slug, { owner: true }));
    (options.limiter || uploadLimiter).consume(`media:${user.id}`);
    return json(await uploadImage(request, shop, session, options), 201);
  }, options.authOptions);
}

module.exports = { MAX_BYTES, MAX_PIXELS, uploadImage, mediaUploadRoute };
