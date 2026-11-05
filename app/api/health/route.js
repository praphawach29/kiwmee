const { getBookingPool } = require("../../../src/v2/db");
const { healthReport } = require("../../../src/v2/health");
const { reminderLoopState } = require("../../../src/v2/line-reminders");

// Railway/monitoring asks this: 200 only when the booking database answers, 503 otherwise.
// Never checks the legacy v1 database (see src/v2/health.js).
async function GET() {
  const report = await healthReport({
    query: (text, params) => getBookingPool().query(text, params),
    reminders: reminderLoopState(),
  });
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
module.exports = { GET };
