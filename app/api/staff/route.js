const { json, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");
const { requireUuid } = require("../../../src/validation");

async function GET(request) {
  return route(async () => {
    const url = new URL(request.url);
    const serviceId = url.searchParams.get("service_id");
    const repository = getRepository();
    if (serviceId) {
      requireUuid(serviceId, "service_id");
      const staff = await repository.listActiveStaffForService(serviceId);
      return json(staff);
    }
    const staff = typeof repository.listAllStaff === "function"
      ? await repository.listAllStaff()
      : [];
    return json(staff);
  });
}

module.exports = { GET };
