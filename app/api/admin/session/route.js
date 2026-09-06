const { route, json } = require("../../../../src/http");
const { adminToken, requireAdmin, verifyPassword } = require("../../../../src/security/access");
const { boundedJson, sameOrigin } = require("../../../../src/security/limits");
const { forbidden } = require("../../../../src/errors");
const { getPilotRepository } = require("../../../../src/repositories/pilot");
const { PersistentRateLimiter } = require("../../../../src/security/persistent-rate-limit");
const { getPilotConfig } = require("../../../../src/config");
const limiter = new PersistentRateLimiter(getPilotRepository());
const key = (request) => request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("user-agent") ?? "unknown";
async function GET(request) { return route(async () => { await requireAdmin(request); return json({ authenticated: true }); }); }
async function POST(request) {
  return route(async () => {
    sameOrigin(request);
    await limiter.consume("admin-login", key(request), { max: 10, windowMs: 15 * 60 * 1000 });
    const body = await boundedJson(request);
    if (!await verifyPassword(body.password))
      throw forbidden("เข้าสู่ระบบไม่สำเร็จ");
    const maxAge = Math.floor(getPilotConfig().adminSessionHours * 3600);
    const expires = Date.now() + maxAge * 1000;
    const response = json({ authenticated: true });
    response.headers.set("set-cookie", `salon_admin=${adminToken(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(request) ? "; Secure" : ""}`);
    return response;
  });
}
async function DELETE(request) {
  return route(async () => {
    sameOrigin(request);
    const session = await requireAdmin(request);
    await getPilotRepository().revokeAdminSession(session.id, new Date(session.expires));
    const response = json({ authenticated: false });
    response.headers.set("set-cookie", `salon_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure(request) ? "; Secure" : ""}`);
    return response;
  });
}
function secure(request) { return request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || new URL(request.url).protocol === "https:"; }
module.exports = { GET, POST, DELETE };
