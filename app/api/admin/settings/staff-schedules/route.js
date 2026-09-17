// Salon Booking OS v1 - Admin Settings: Staff Weekly Schedules API
const { json, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { requireAdmin } = require("../../../../../src/security/access");
const { boundedJson } = require("../../../../../src/security/limits");
const { requireUuid, optionalUuid } = require("../../../../../src/validation");
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
    const staffId = optionalUuid(url.searchParams.get("staff_id"), "staff_id");

    const repository = getRepository();
    const schedules = await repository.listStaffSchedules(tenantId, staffId);
    return json({ business_id: tenantId, schedules });
  });
}

async function PUT(request) {
  return route(async () => {
    const session = await requireAdmin(request);
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || "default";
    if (tenantId !== "default") {
      throw forbidden("ระบบยังไม่เปิดให้แก้ไขการตั้งค่าสำหรับธุรกิจนี้ (Pilot mode only)");
    }

    const body = await boundedJson(request);
    if (!body || !Array.isArray(body.schedules)) {
      throw badRequest("schedules must be an array");
    }

    const validatedSchedules = body.schedules.map((s, idx) => {
      const staffId = requireUuid(s.staff_id, `schedules[${idx}].staff_id`);
      const day = Number(s.day_of_week);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw badRequest(`schedules[${idx}].day_of_week must be an integer between 0 and 6`);
      }
      const isWorking = Boolean(s.is_working);
      let startTime = s.start_time ? validateTime(s.start_time, `schedules[${idx}].start_time`) : "10:00";
      let endTime = s.end_time ? validateTime(s.end_time, `schedules[${idx}].end_time`) : "19:00";

      if (isWorking && startTime >= endTime) {
        throw badRequest(`schedules[${idx}]: start_time (${startTime}) must be before end_time (${endTime})`);
      }

      return {
        staff_id: staffId,
        day_of_week: day,
        is_working: isWorking,
        start_time: startTime,
        end_time: endTime
      };
    });

    const repository = getRepository();
    const updated = await repository.upsertStaffSchedule(tenantId, validatedSchedules);
    return json({ ok: true, schedules: updated });
  });
}

module.exports = { GET, PUT };
