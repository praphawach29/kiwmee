const { ConsoleNotificationProvider, ShadowNotificationProvider } = require("./providers");
const { LineAutomationNotificationProvider } = require("../messaging/line-automation-provider");
const { createLineMessaging } = require("../messaging/runtime");
function createNotificationProvider(repository, config) {
  const mode = config.automationDeliveryMode ?? "shadow";
  if (mode === "shadow") return new ShadowNotificationProvider();
  if (mode === "console") return new ConsoleNotificationProvider();
  if (mode === "live" && config.lineEnabled) {
    return new LineAutomationNotificationProvider(repository, createLineMessaging(config));
  }
  throw new Error("live automation delivery requires LINE_ENABLED=true");
}
module.exports = { createNotificationProvider };
