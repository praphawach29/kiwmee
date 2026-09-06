const { json, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");
const { requireUuid } = require("../../../src/validation");

async function GET(request) {
  return route(async () => {
    const url = new URL(request.url);
    const serviceId = requireUuid(url.searchParams.get("service_id"), "service_id");
    const staff = await getRepository().listActiveStaffForService(serviceId);
    return json(staff);
  });
}

module.exports = { GET };
