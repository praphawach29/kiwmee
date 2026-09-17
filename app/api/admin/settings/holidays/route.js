// Salon Booking OS v1 - Admin Settings: Business Holidays / Closures API
const { json, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { requireAdmin } = require("../../../../../src/security/access");
const { boundedJson } = require("../../../../../src/security/limits");
const { requireDate } = require("../../../../../src/validation");
const { badRequest, forbidden } = require("../../../../../src/errors");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateTime(val, field) {
  if (typeof val !== "string" || !TIME_RE.test(val.slice(0, 5))) {
    throw badRequest(`${field} must be in HH:MM format (00:00 - 23:59)`);
  }
  return val.slice(0, 5);
}

async function GET(request) {
  return route(async () => {
    const session = await requireAdmin(request);
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || "default";
    const url = new URL(request.url);
    const fromDate = url.searchParams.get("from");
    const toDate = url.searchParams.get("to");

    if (fromDate) requireDate(fromDate, "from");
    if (toDate) requireDate(toDate, "to");

    const repository = getRepository();
    const closures = await repository.listBusinessClosures(tenantId, fromDate, toDate);
    return json({ business_id: tenantId, closures });
  });
}

async function POST(request) {
  return route(async () => {
    const session = await requireAdmin(request);
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || "default";
    if (tenantId !== "default") {
      throw forbidden("ระบบยังไม่เปิดให้แก้ไขการตั้งค่าสำหรับธุรกิจนี้ (Pilot mode only)");
    }

    const body = await boundedJson(request);
    if (!body || typeof body !== "object") {
      throw badRequest("body must be an object");
    }

    const closureDate = requireDate(body.closure_date, "closure_date");
    const isAllDay = body.is_all_day !== false;
    let startTime = null;
    let endTime = null;

    if (!isAllDay) {
      startTime = validateTime(body.start_time, "start_time");
      endTime = validateTime(body.end_time, "end_time");
      if (startTime >= endTime) {
        throw badRequest(`start_time (${startTime}) must be before end_time (${endTime})`);
      }
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

    const repository = getRepository();
    const closure = await repository.createBusinessClosure({
      business_id: tenantId,
      closure_date: closureDate,
      is_all_day: isAllDay,
      start_time: startTime,
      end_time: endTime,
      reason
    });

    return json({ ok: true, closure }, 201);
  });
}

module.exports = { GET, POST };
