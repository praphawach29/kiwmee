const { route, json } = require("../../../../src/http");
const { badRequest } = require("../../../../src/errors");
const { cookie } = require("../../../../src/security/access");
const { boundedJson } = require("../../../../src/security/limits");
const { getAIRuntime } = require("../../../../src/ai/runtime");
const { requireUuid } = require("../../../../src/validation");
const { AppError } = require("../../../../src/errors");
async function POST(request) {
  return route(async () => {
    const runtime = getAIRuntime();
    if (!runtime.config.aiEnabled) throw new AppError("AI_DISABLED", "ผู้ช่วยนัดหมายยังไม่เปิดใช้งาน", 503);
    const body = await boundedJson(request);
    if (!body || Object.keys(body).some((k) => !["session_id", "message"].includes(k)) ||
      typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000 ||
      (body.session_id !== undefined && body.session_id !== null && typeof body.session_id !== "string")) throw badRequest("ข้อความไม่ถูกต้องหรือยาวเกิน 2000 ตัวอักษร");
    const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("user-agent") ?? "unknown";
    await runtime.limiter.consume("ai-request", clientKey, { max: 60, windowMs: 60000 });
    let sessionId = body.session_id ? requireUuid(body.session_id, "session_id") : null;
    let owner = cookie(request, "ai_owner");
    if (!sessionId) {
      await runtime.limiter.consume("ai-session-create", clientKey, { max: 10, windowMs: 60000 });
      const created = await runtime.sessions.create({ type: "web" }); sessionId = created.session.id; owner = created.owner;
    }
    const result = await runtime.sessions.withSession(sessionId, owner,
      (session) => runtime.receptionist.respond(session, body.message));
    await runtime.repository.cleanup();
    const response = json(result);
    response.headers.set("cache-control", "no-store");
    response.headers.set("set-cookie", `ai_owner=${owner}; HttpOnly; SameSite=Strict; Path=/api/ai; Max-Age=1800${isSecure(request) ? "; Secure" : ""}`);
    return response;
  });
}
function isSecure(request) { return request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || new URL(request.url).protocol === "https:"; }
module.exports = { POST };
