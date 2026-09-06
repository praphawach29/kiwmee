const { updateBookingStatus } = require("../../../../../src/automation/booking-orchestration");
const { getParams, json, readJson, route } = require("../../../../../src/http");
const { getRepository } = require("../../../../../src/repositories");
const { optionalString, requireStatus, requireUuid } = require("../../../../../src/validation");
const { requireAdmin } = require("../../../../../src/security/access");
const { sameOrigin } = require("../../../../../src/security/limits");

async function PATCH(request, context) {
  return route(async () => {
    sameOrigin(request);
    await requireAdmin(request);
    const params = await getParams(context);
    const bookingId = requireUuid(params.id, "id");
    const payload = await readJson(request);
    const booking = await updateBookingStatus(getRepository(), bookingId, {
      status: requireStatus(payload.status),
      reason: optionalString(payload.reason),
      changed_by: optionalString(payload.changed_by) ?? "web"
    });
    return json(booking);
  });
}

module.exports = { PATCH };
