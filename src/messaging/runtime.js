const { getPilotConfig } = require("../config");
const { LineMessagingProvider } = require("./providers");
const { LineWebhookService } = require("./line-webhook-service");
const { getAIRuntime } = require("../ai/runtime");
function createLineMessaging(config = getPilotConfig(), options = {}) {
  return new LineMessagingProvider({ channelSecret: config.lineChannelSecret, accessToken: config.lineAccessToken, ...options });
}
function getLineWebhookService() {
  const runtime = getAIRuntime(); const messaging = createLineMessaging(runtime.config);
  return new LineWebhookService({ messaging, sessions: runtime.sessions, receptionist: runtime.receptionist,
    repository: runtime.repository, limiter: runtime.limiter, channelSecret: runtime.config.lineChannelSecret });
}
module.exports = { createLineMessaging, getLineWebhookService };
