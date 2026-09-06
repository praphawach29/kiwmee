// Deliberately excludes messages, tool arguments, customer data, tokens and exception text.
function auditTool(name, result, sink = console.info) {
  if (process.env.AI_AUDIT_LOGGING !== "true") return;
  require("../observability/logger").logEvent("ai_tool_invocation",
    { tool: name, status: result.ok ? "ok" : "failed", code: result.ok ? "OK" : result.error.code }, sink);
}
module.exports = { auditTool };
