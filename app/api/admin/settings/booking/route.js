// Salon Booking OS v1 - Admin Settings: Booking Settings API
const { json, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { requireAdmin } = require("../../../../../src/security/access");
const { boundedJson } = require("../../../../../src/security/limits");
const { badRequest, forbidden } = require("../../../../../src/errors");

const ALLOWED_INTERVALS = [5, 10, 15, 20, 30, 60];

async function GET(request) {
  return route(async () => {
    const session = await requireAdmin(request);
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || "default";
    const repository = getRepository();
    const settings = await repository.getBusinessBookingSettings(tenantId);
    return json({ business_id: tenantId, settings });
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
    if (!body || typeof body !== "object") {
      throw badRequest("body must be an object");
    }

    const updates = {};

    if (body.lead_time_minutes !== undefined) {
      const lead = Number(body.lead_time_minutes);
      if (!Number.isInteger(lead) || lead < 0 || lead > 1440) {
        throw badRequest("lead_time_minutes must be an integer between 0 and 1440");
      }
      updates.lead_time_minutes = lead;
    }

    if (body.slot_interval_minutes !== undefined) {
      const interval = Number(body.slot_interval_minutes);
      if (!ALLOWED_INTERVALS.includes(interval)) {
        throw badRequest(`slot_interval_minutes must be one of: ${ALLOWED_INTERVALS.join(", ")}`);
      }
      updates.slot_interval_minutes = interval;
    }

    if (body.max_advance_days !== undefined) {
      const advance = Number(body.max_advance_days);
      if (!Number.isInteger(advance) || advance < 1 || advance > 365) {
        throw badRequest("max_advance_days must be an integer between 1 and 365");
      }
      updates.max_advance_days = advance;
    }

    const repository = getRepository();
    const settings = await repository.updateBusinessBookingSettings(tenantId, updates);
    return json({ ok: true, settings });
  });
}

module.exports = { GET, PUT };
