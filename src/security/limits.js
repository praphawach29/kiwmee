const { AppError } = require("../errors");

class MemoryRateLimiter {
  constructor({ max = 30, windowMs = 60000, now = Date.now } = {}) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.buckets = new Map();
  }
  consume(key) {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(id);
    const bucket = this.buckets.get(key) ?? { count: 0, until: now + this.windowMs };
    if (this.buckets.size >= 10000 && !this.buckets.has(key)) throw new AppError("RATE_LIMITED", "กรุณาลองใหม่ภายหลัง", 429);
    this.buckets.set(key, bucket);
    if (++bucket.count > this.max) throw new AppError("RATE_LIMITED", "ส่งข้อความถี่เกินไป กรุณารอสักครู่", 429);
  }
}
const limiter = new MemoryRateLimiter({ max: 60 });

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let source;
  try { source = new URL(origin); } catch { throw new AppError("FORBIDDEN", "Origin is not allowed", 403); }
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const expectedProtocol = forwardedProto ? `${forwardedProto}:` : new URL(request.url).protocol;
  if (source.host !== expectedHost || source.protocol !== expectedProtocol)
    throw new AppError("FORBIDDEN", "Origin is not allowed", 403);
}

async function boundedJson(request) {
  sameOrigin(request);
  const reader = request.body?.getReader();
  let size = 0; const chunks = [];
  if (!reader) throw new AppError("BAD_REQUEST", "กรุณาส่งข้อมูล", 400);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new AppError("BAD_REQUEST", "ข้อความยาวเกินไป", 413); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("BAD_REQUEST", "ข้อมูลไม่ถูกต้อง", 400); }
}
module.exports = { MemoryRateLimiter, limiter, sameOrigin, boundedJson };
