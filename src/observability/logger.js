const ALLOWED = new Set(["booking_created","booking_conflict","automation_job_failure","ai_tool_invocation","handoff_created","line_webhook_failure","ai_provider_error","ai_receptionist_error"]);
function sanitizeError(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/sk-[a-zA-Z0-9_\-]+/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/OPENAI_API_KEY=[^\s,;]+/gi, "OPENAI_API_KEY=[REDACTED]")
    .replace(/private/gi, "[REDACTED]")
    .slice(0, 500);
}
function logEvent(event, fields = {}, sink = console.info) {
  if (!ALLOWED.has(event)) return;
  const safe = { event, timestamp: new Date().toISOString() };
  for (const key of ["booking_id","session_id","job_id","tool","code","status","channel","automation_type","model"])
    if (typeof fields[key] === "string" || typeof fields[key] === "number" || typeof fields[key] === "boolean") safe[key] = fields[key];
  if (fields.error) safe.error = sanitizeError(fields.error);
  sink(JSON.stringify(safe));
}
module.exports = { logEvent, sanitizeError };
