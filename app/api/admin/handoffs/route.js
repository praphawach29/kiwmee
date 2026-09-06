const { route, json } = require("../../../../src/http");
const { requireAdmin } = require("../../../../src/security/access");
const { getPilotRepository } = require("../../../../src/repositories/pilot");
async function GET(request) {
  return route(async () => { await requireAdmin(request); return json({ handoffs: await getPilotRepository().listHandoffs() }); });
}
module.exports = { GET };
