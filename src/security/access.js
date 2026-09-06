const { createHmac, timingSafeEqual, randomUUID, scrypt: scryptCallback } = require("node:crypto");
const { promisify } = require("node:util");
const { forbidden } = require("../errors");
const { PhoneMatchVerificationProvider, normalizePhone } = require("./verification");
const scrypt = promisify(scryptCallback);

function same(a, b) {
  const left = Buffer.from(a ?? ""); const right = Buffer.from(b ?? "");
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookie(request, name) {
  return request.headers.get("cookie")?.split(";").map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}
function adminToken(expires = Date.now() + 8 * 60 * 60 * 1000, id = randomUUID()) {
  if (!process.env.ADMIN_SESSION_SECRET) throw forbidden("Admin access is not configured");
  const signature = createHmac("sha256", process.env.ADMIN_SESSION_SECRET).update(`${id}:${expires}`).digest("hex");
  return `${id}.${expires}.${signature}`;
}
function parseAdminToken(request) {
  const token = cookie(request, "salon_admin"); const [id, rawExpires] = token.split("."); const expires = Number(rawExpires);
  if (!process.env.ADMIN_SESSION_SECRET || !/^[0-9a-f-]{36}$/i.test(id ?? "") || !Number.isFinite(expires) || expires <= Date.now()) return null;
  return same(token, adminToken(expires, id)) ? { id, expires, token } : null;
}
function isAdmin(request) { return Boolean(parseAdminToken(request)); }
async function requireAdmin(request) {
  const session = parseAdminToken(request);
  if (!session) throw forbidden("กรุณาเข้าสู่ระบบพนักงาน");
  if (await require("../repositories/pilot").getPilotRepository().isAdminSessionRevoked(session.id))
    throw forbidden("เซสชันพนักงานหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  return session;
}
async function authorizeBooking(request, repository, id) {
  if (isAdmin(request)) { await requireAdmin(request); return; }
  const provider = new PhoneMatchVerificationProvider();
  if (!await provider.verifyBooking({ repository, bookingId: id, proof: { phone: request.headers.get("x-booking-phone") } }))
    throw forbidden("ไม่สามารถยืนยันข้อมูลนัดหมายได้");
}
async function verifyPassword(password, encoded = process.env.ADMIN_PASSWORD_HASH) {
  if (typeof password !== "string" || !encoded) return false;
  const [algorithm, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !/^[0-9a-f]+$/i.test(expected ?? "")) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const actual = await scrypt(password, salt, expectedBytes.length);
  return expectedBytes.length === actual.length && timingSafeEqual(expectedBytes, actual);
}
module.exports = { same, cookie, adminToken, parseAdminToken, isAdmin, requireAdmin, authorizeBooking, normalizePhone, verifyPassword };
