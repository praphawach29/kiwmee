const { getPilotConfig } = require("../config");
const { getPilotRepository } = require("../repositories/pilot");
const { PersistentSessionStore } = require("./persistent-sessions");
const { PersistentRateLimiter } = require("../security/persistent-rate-limit");
const { ToolGateway } = require("./tools/gateway");
const { apiClient } = require("./tools/api-client");
const { Receptionist } = require("./receptionist");
const { createAIProvider } = require("./provider");
const { HandoffService } = require("./handoff-service");
const { DEFAULT_SINGLE_BUSINESS_ID } = require("../licensing");
let runtime;
function getAIRuntime() {
  if (!runtime) {
    const config = getPilotConfig(); const repository = getPilotRepository();
    runtime = { config, repository, sessions: new PersistentSessionStore(repository),
      limiter: new PersistentRateLimiter(repository) };
    runtime.receptionist = new Receptionist(new ToolGateway(apiClient), createAIProvider(config),
      new HandoffService(repository, config), { businessId: config.businessId || DEFAULT_SINGLE_BUSINESS_ID });
  }
  return runtime;
}
function resetAIRuntime() { runtime = null; }
module.exports = { getAIRuntime, resetAIRuntime };
