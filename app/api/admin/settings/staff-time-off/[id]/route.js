// Salon Booking OS v1 - Admin Settings: Delete Staff Time Off API
const { json, route } = require("../../../../../../src/http");
const { getRepository } = require("../../../../../../src/repositories");
const { requireAdmin } = require("../../../../../../src/security/access");
const { sameOrigin } = require("../../../../../../src/security/limits");
const { requireUuid } = require("../../../../../../src/validation");
const { forbidden } = require("../../../../../../src/errors");

async function DELETE(request, { params }) {
  return route(async () => {
    sameOrigin(request);
    const session = await requireAdmin(request);
    const tenantId = session.business_id || session.tenant_id || request.headers.get("x-business-id") || "default";
    if (tenantId !== "default") {
      throw forbidden("ระบบยังไม่เปิดให้แก้ไขการตั้งค่าสำหรับธุรกิจนี้ (Pilot mode only)");
    }

    const resolvedParams = await params;
    const timeOffId = requireUuid(resolvedParams.id, "id");
    const repository = getRepository();
    const deleted = await repository.deleteStaffTimeOff(timeOffId, tenantId);

    return json({ ok: true, deleted });
  });
}

module.exports = { DELETE };
