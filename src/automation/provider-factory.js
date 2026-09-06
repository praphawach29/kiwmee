const { ConsoleNotificationProvider } = require("./providers");
const { LineAutomationNotificationProvider } = require("../messaging/line-automation-provider");
const { createLineMessaging } = require("../messaging/runtime");
function createNotificationProvider(repository, config) {
  if (config.lineEnabled) return new LineAutomationNotificationProvider(repository, createLineMessaging(config));
  return new ConsoleNotificationProvider();
}
module.exports = { createNotificationProvider };
