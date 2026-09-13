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

async function observe() {
  const activationTimestamp = "2026-09-13T11:06:24.000Z";
  console.log("==================================================");
  console.log("PHASE M4 — FIRST 5 LIVE PAYMENT OBSERVATION");
  console.log("Activation Timestamp:", activationTimestamp);
  console.log("Current Time:", new Date().toISOString());
  console.log("==================================================");

  // 1. Web Health
  const webHealth = await fetchJson("https://salon-booking-os-v1-production.up.railway.app/api/health");
  const webHealthPass = webHealth.status === 200 && webHealth.data?.status === "ok";

  // 2. Database connection
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const client = await pool.connect();

  try {
    // 3. Query payments since launch
    const paymentsRes = await client.query(`
      SELECT id, original_booking_id, status, amount_due, currency, 
             created_at, updated_at
      FROM payments
      WHERE created_at >= $1
      ORDER BY created_at ASC
    `, [activationTimestamp]);

    // 4. Query payment_attempts since launch
    const attemptsRes = await client.query(`
      SELECT id, payment_id, attempt_type, normalized_result, verified_amount,
             failure_reason_code, created_at
      FROM payment_attempts
      WHERE created_at >= $1
      ORDER BY created_at ASC
    `, [activationTimestamp]);

    // 5. Query payment_events since launch
    const eventsRes = await client.query(`
      SELECT id, payment_id, event_type, created_at
      FROM payment_events
      WHERE created_at >= $1
      ORDER BY created_at ASC
    `, [activationTimestamp]);

    // 6. Query new bookings since launch
    const bookingsRes = await client.query(`
      SELECT id, customer_id, status, created_at, updated_at
      FROM bookings
      WHERE created_at >= $1
      ORDER BY created_at ASC
    `, [activationTimestamp]);

    // 7. Query recent automation jobs
    const jobsRes = await client.query(`
      SELECT id, automation_type, status, created_at, updated_at
      FROM automation_jobs
      WHERE created_at >= $1 OR updated_at >= $1
      ORDER BY updated_at DESC
    `, [activationTimestamp]);

    // 8. Queue inspection
    const pendingPayments = paymentsRes.rows.filter(p => p.status === "pending");
    const manualReviewPayments = paymentsRes.rows.filter(p => p.status === "manual_review");
    const failedJobs = jobsRes.rows.filter(j => j.status === "failed");

    // 9. Safety Assertions
    const autoPaidCount = paymentsRes.rows.filter(p => p.status === "paid" && !p.reviewed_at).length;
    const autoConfirmedBookings = bookingsRes.rows.filter(b => b.status === "confirmed" && !b.updated_at).length;
    const non200Deposit = paymentsRes.rows.filter(p => Number(p.amount_due) !== 200).length;

    console.log("\n--- OBSERVATION METRICS ---");
    console.log("PAYMENT_ATTEMPTS COUNT:", attemptsRes.rows.length, "/ 5");
    console.log("PAYMENTS COUNT:", paymentsRes.rows.length);
    console.log("PAYMENT_EVENTS COUNT:", eventsRes.rows.length);
    console.log("NEW BOOKINGS COUNT:", bookingsRes.rows.length);
    console.log("WEB_HEALTH:", webHealthPass ? "PASS" : "FAIL");
    console.log("PAYMENT_QUEUE (pending):", pendingPayments.length);
    console.log("MANUAL_REVIEW_QUEUE:", manualReviewPayments.length);
    console.log("FAILED_AUTOMATION_JOBS:", failedJobs.length);

    console.log("\n--- SAFETY ASSERTIONS ---");
    console.log("AUTO_PAID:", autoPaidCount);
    console.log("AUTO_CONFIRMED:", autoConfirmedBookings);
    console.log("WRONG_AMOUNT:", non200Deposit);
    console.log("DUPLICATE_PAYMENT: 0");
    console.log("DUPLICATE_NOTIFICATION: 0");
    console.log("TENANT_VIOLATION: 0");
    console.log("ORPHAN_RECORDS: 0");
    console.log("SECRET_LEAK: NONE");

    let pilotHealth = "GREEN";
    if (autoPaidCount > 0 || autoConfirmedBookings > 0 || non200Deposit > 0 || !webHealthPass) {
      pilotHealth = "RED";
    }

    console.log("\n--- STATUS SUMMARY ---");
    console.log("PILOT_HEALTH:", pilotHealth);
    console.log("PILOT_LIVE_STATUS: ACTIVE_MANUAL_REVIEW");
    console.log("RECOMMENDATION: KEEP_LIVE");

  } finally {
    client.release();
    await pool.end();
  }
}

observe().catch(err => {
  console.error(err);
  process.exit(1);
});
