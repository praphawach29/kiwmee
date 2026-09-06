const { json, route } = require("../../../src/http");
const { getRepository } = require("../../../src/repositories");

async function GET() {
  return route(async () => {
    const services = await getRepository().listServices();
    return json(services);
  });
}

module.exports = { GET };
