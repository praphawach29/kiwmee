const { Pool } = require("pg");
const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on("error", reject);
  });
}

async function run() {
  console.log("==================================================");
  console.log("0. FINAL LAUNCH PRECHECK");
  console.log("==================================================");

  // 1. Web Health Check
  const webHealth = await fetchJson("https://salon-booking-os-v1-production.up.railway.app/api/health");
  console.log("WEB_HEALTH HTTP status:", webHealth.status, "data:", webHealth.data || webHealth.raw);

  // 2. DB checks
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const client = await pool.connect();

  try {
    // Migration 007 tables
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('payments', 'payment_allocations', 'payment_attempts', 'payment_events', 'refunds', 'business_integrations')
      ORDER BY table_name
    `);
    const tables = tableRes.rows.map(r => r.table_name);
    const m007Applied = tables.length === 6;
    console.log("Migration 007 tables found (" + tables.length + "/6):", tables);

    // EasySlip API key
    const easyslipPresent = Boolean(process.env.EASYSLIP_API_KEY && process.env.EASYSLIP_API_KEY.trim().length > 0);
    console.log("EASYSLIP_API_KEY present:", easyslipPresent);

    // business_integrations
    const integRes = await client.query(`
      SELECT id, business_id, integration_type, provider, enabled, credential_reference, public_metadata 
      FROM business_integrations
      WHERE business_id = 'default'
    `);
    const bi = integRes.rows[0];
    console.log("business_integrations row:", bi);

    const providerMatch = bi?.provider === 'easyslip_v2';
    const enabledMatch = bi?.enabled === true;
    const authoritativeFalse = bi?.public_metadata?.authoritative === false;
    const autoConfirmFalse = bi?.public_metadata?.auto_confirm === false;

    console.log("business_integrations checks:", {
      providerMatch,
      enabledMatch,
      authoritativeFalse,
      autoConfirmFalse
    });

    // Check worker health / activity
    const workerJobs = await client.query(`
      SELECT id, automation_type, status, created_at, updated_at 
      FROM automation_jobs 
      ORDER BY updated_at DESC 
      LIMIT 5
    `);
    console.log("Recent automation jobs (worker health evidence):", workerJobs.rows);

    // Tenant isolation verification: check non-pilot business
    const nonPilotInteg = await client.query(`
      SELECT count(*)::int as count FROM business_integrations WHERE business_id != 'default'
    `);
    console.log("Non-pilot integrations count:", nonPilotInteg.rows[0].count);

    console.log("\n==================================================");
    console.log("1. PRODUCTION SNAPSHOT");
    console.log("==================================================");
    const snapshotTimestamp = new Date().toISOString();
    console.log("Snapshot Timestamp:", snapshotTimestamp);
    console.log("Pilot business_id:", "default");
    console.log("Pilot business name:", "Luxe Hair & Beauty Studio");

    const bookingsByStatus = await client.query(`
      SELECT status, count(*)::int as count 
      FROM bookings 
      GROUP BY status 
      ORDER BY status
    `);
    console.log("Booking counts by status:", bookingsByStatus.rows);

    const paymentsCount = await client.query("SELECT count(*)::int as count FROM payments");
    console.log("Payments count:", paymentsCount.rows[0].count);

    const attemptsCount = await client.query("SELECT count(*)::int as count FROM payment_attempts");
    console.log("Payment attempts count:", attemptsCount.rows[0].count);

    const eventsCount = await client.query("SELECT count(*)::int as count FROM payment_events");
    console.log("Payment events count:", eventsCount.rows[0].count);

    const jobsCount = await client.query(`
      SELECT status, count(*)::int as count 
      FROM automation_jobs 
      GROUP BY status 
      ORDER BY status
    `);
    console.log("Automation jobs counts by status:", jobsCount.rows);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
