const { route, json } = require("../../../../src/http");
const { AppError } = require("../../../../src/errors");
const { getPilotConfig } = require("../../../../src/config");
const { getLineWebhookService } = require("../../../../src/messaging/runtime");
const { logEvent } = require("../../../../src/observability/logger");
async function POST(request) {
  return route(async () => {
    if (!getPilotConfig().lineEnabled) throw new AppError("LINE_DISABLED", "LINE integration is disabled", 503);
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 1024 * 1024) throw new AppError("BAD_REQUEST", "LINE payload is too large", 413);
    try { return json(await getLineWebhookService().handle(raw, request.headers.get("x-line-signature"))); }
    catch (error) {
      logEvent("line_webhook_failure", { code: error.code ?? "LINE_WEBHOOK_ERROR", channel: "line" });
      if (error.code === "INVALID_SIGNATURE") throw new AppError("FORBIDDEN", "Invalid LINE signature", 401);
      if (error.code === "BAD_REQUEST") throw new AppError("BAD_REQUEST", "Invalid LINE payload", 400);
      throw new AppError("LINE_WEBHOOK_ERROR", "LINE webhook processing failed", 500);
    }
  });
}
module.exports = { POST };
