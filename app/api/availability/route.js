const { getAvailableSlots } = require("../../../src/availability-engine");
const { json, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");
const { optionalUuid, requireDate, requireUuid } = require("../../../src/validation");

async function GET(request) {
  return route(async () => {
    const url = new URL(request.url);
    const serviceId = requireUuid(url.searchParams.get("service_id"), "service_id");
    const staffId = optionalUuid(url.searchParams.get("staff_id"), "staff_id");
    const date = requireDate(url.searchParams.get("date"), "date");

    const result = await getAvailableSlots(getRepository(), {
      serviceId,
      staffId,
      date
    });
    return json(result);
  });
}

module.exports = { GET };
