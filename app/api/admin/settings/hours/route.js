// Salon Booking OS v1 - Admin Settings: Business Hours API
const { json, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { requireAdmin } = require("../../../../../src/security/access");
const { boundedJson } = require("../../../../../src/security/limits");
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
    const repository = getRepository();
    const hours = await repository.listBusinessHours(tenantId);
    return json({ business_id: tenantId, hours });
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
    if (!body || !Array.isArray(body.hours)) {
      throw badRequest("hours must be an array");
    }

    const validatedHours = body.hours.map((h, idx) => {
      const day = Number(h.day_of_week);
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw badRequest(`hours[${idx}].day_of_week must be an integer between 0 and 6`);
      }
      const isOpen = Boolean(h.is_open);
      let openTime = h.open_time ? validateTime(h.open_time, `hours[${idx}].open_time`) : "10:00";
      let closeTime = h.close_time ? validateTime(h.close_time, `hours[${idx}].close_time`) : "19:00";

      if (isOpen && openTime >= closeTime) {
        throw badRequest(`hours[${idx}]: open_time (${openTime}) must be before close_time (${closeTime})`);
      }

      return {
        day_of_week: day,
        is_open: isOpen,
        open_time: openTime,
        close_time: closeTime
      };
    });

    const repository = getRepository();
    const updated = await repository.upsertBusinessHours(tenantId, validatedHours);
    return json({ ok: true, hours: updated });
  });
}

module.exports = { GET, PUT };
