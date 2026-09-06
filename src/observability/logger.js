const ALLOWED = new Set(["booking_created","booking_conflict","automation_job_failure","ai_tool_invocation","handoff_created","line_webhook_failure"]);
function logEvent(event, fields = {}, sink = console.info) {
  if (!ALLOWED.has(event)) return;
  const safe = { event, timestamp: new Date().toISOString() };
  for (const key of ["booking_id","session_id","job_id","tool","code","status","channel","automation_type"])
    if (typeof fields[key] === "string" || typeof fields[key] === "number" || typeof fields[key] === "boolean") safe[key] = fields[key];
  sink(JSON.stringify(safe));
}
module.exports = { logEvent };
