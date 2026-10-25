// Connection to the v2 database (Supabase project booking-v2) for server-side code only.
// BOOKING_DB_URL: the Supabase connection string. On Railway (a long-running server) use the
// Session pooler; on serverless hosts use the Transaction pooler (port 6543).
// The server connects as the database owner, so RLS does not apply; every query here must be
// scoped to one shop by the caller.

let pool;

function sslConfig(url) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.BOOKING_DB_SSL === "false") return false;
  // Supabase signs its database certificate with its own CA (Dashboard → Database → SSL).
  // With that certificate in BOOKING_DB_CA the connection is verified; without it, it is
  // encrypted but not verified, as the v1 repositories do.
  if (process.env.BOOKING_DB_CA) return { ca: process.env.BOOKING_DB_CA.replace(/\\n/g, "\n") };
  return { rejectUnauthorized: false };
}

function getBookingPool() {
  if (!pool) {
    const url = process.env.BOOKING_DB_URL;
    if (!url) throw new Error("BOOKING_DB_URL is not set");
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: url, max: 3, ssl: sslConfig(url) });
    // An idle connection dropped by the pooler must not crash the server; the pool reconnects
    pool.on("error", (error) => console.error("[booking-db] idle connection error:", error.message));
  }
  return pool;
}

module.exports = { getBookingPool, sslConfig };
