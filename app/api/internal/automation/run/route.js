const { getBookingConfig } = require("../../../../../src/config");
const { forbidden } = require("../../../../../src/errors");
const { json, route } = require("../../../../../src/http");
const { runAutomationCycle } = require("../../../../../src/automation/automation-service");
const { createNotificationProvider } = require("../../../../../src/automation/provider-factory");
const { getRepository } = require("../../../../../src/repositories");

async function POST(request) {
  return route(async () => {
    const config = getBookingConfig();
    const authorization = request.headers.get("authorization") ?? "";
    const supplied = request.headers.get("x-automation-secret") ?? authorization.replace(/^Bearer\s+/i, "");
    if (!config.automationInternalSecret || supplied !== config.automationInternalSecret) {
      throw forbidden("automation runner is protected");
    }

    const result = await runAutomationCycle(getRepository(), {
      config,
      provider: createNotificationProvider(getRepository(), require("../../../../../src/config").getPilotConfig())
    });
    return json(result);
  });
}

module.exports = { POST };
