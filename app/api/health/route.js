const { getPilotConfig } = require("../../../src/config");
const { getPilotRepository } = require("../../../src/repositories/pilot");
async function GET() {
  const config = getPilotConfig();
  try {
    await getPilotRepository().health();
    return Response.json({ status: "ok", database: "ready", business: config.businessName,
      ai: config.aiEnabled ? config.aiProvider : "disabled", line: config.lineEnabled ? "enabled" : "disabled" },
    { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "degraded", database: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } });
  }
}
module.exports = { GET };
