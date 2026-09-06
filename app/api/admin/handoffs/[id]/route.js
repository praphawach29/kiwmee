const { route, json, readJson, getParams } = require("../../../../../src/http");
const { requireAdmin } = require("../../../../../src/security/access");
const { sameOrigin } = require("../../../../../src/security/limits");
const { getPilotRepository } = require("../../../../../src/repositories/pilot");
const { requireUuid } = require("../../../../../src/validation");
const { badRequest, notFound } = require("../../../../../src/errors");
async function PATCH(request, context) {
  return route(async () => {
    sameOrigin(request); await requireAdmin(request);
    const id = requireUuid((await getParams(context)).id, "id"); const body = await readJson(request);
    if (!body || Object.keys(body).length !== 1 || !["accepted","resolved"].includes(body.status)) throw badRequest("status is invalid");
    const handoff = await getPilotRepository().updateHandoff(id, body.status);
    if (!handoff) throw notFound("handoff request not found");
    return json(handoff);
  });
}
module.exports = { PATCH };
