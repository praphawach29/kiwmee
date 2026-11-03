const { validateRuntimeConfig } = require("./src/config");
async function register() {
  if (process.env.PILOT_STRICT_CONFIG === "true") validateRuntimeConfig();
  // LINE appointment reminders (src/v2/line-reminders.js): the running server checks every 5 minutes.
  // Set LINE_REMINDERS=off to stop them (e.g. a second server that should not send).
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.BOOKING_DB_URL && process.env.LINE_REMINDERS !== "off") {
    const { startReminderLoop } = require("./src/v2/line-reminders");
    const { getBookingPool } = require("./src/v2/db");
    startReminderLoop(getBookingPool);
  }
  // Rental documents (src/v2/rental-documents.js) are deleted on schedule, every hour (PDPA)
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.BOOKING_DB_URL) {
    const { startDocumentPurge } = require("./src/v2/rental-documents");
    const { getBookingPool } = require("./src/v2/db");
    startDocumentPurge(getBookingPool);
  }
}
module.exports = { register };
