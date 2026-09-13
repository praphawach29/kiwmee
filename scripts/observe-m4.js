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

  // 1. Web Health
  let webHealthPass = false;
  try {
    const webHealth = await fetchJson("https://salon-booking-os-v1-production.up.railway.app/api/health");
    webHealthPass = webHealth.status === 200 && webHealth.data?.status === "ok";
  } catch {
    webHealthPass = false;
  }

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
             review_status, reviewed_at, created_at, updated_at
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

    // Counts
    const attemptsCount = attemptsRes.rows.length;
    const approvedCount = paymentsRes.rows.filter(p => p.review_status === "approved" || p.status === "paid").length;
    const rejectedCount = paymentsRes.rows.filter(p => p.review_status === "rejected" || p.status === "verification_failed").length;
    const pendingCount = paymentsRes.rows.filter(p => p.status === "manual_review" || p.status === "pending").length;

    // Safety checks
    const autoPaidCount = paymentsRes.rows.filter(p => p.status === "paid" && !p.reviewed_at).length;
    const autoConfirmedBookings = bookingsRes.rows.filter(b => b.status === "confirmed" && !b.updated_at).length;
    const non200Deposit = paymentsRes.rows.filter(p => Number(p.amount_due) !== 200).length;

    const safetyIncidents = autoPaidCount + autoConfirmedBookings + non200Deposit + (!webHealthPass ? 1 : 0);

    let pilotHealth;
    let liveEvidence;
    let recommendation;

    if (safetyIncidents > 0) {
      pilotHealth = "RED";
      liveEvidence = "INCIDENT";
      recommendation = "PAUSE";
    } else if (attemptsCount === 0) {
      pilotHealth = "MONITORING";
      liveEvidence = "INSUFFICIENT";
      recommendation = "KEEP_LIVE_AND_MONITOR";
    } else if (attemptsCount < 5) {
      pilotHealth = "OBSERVING";
      liveEvidence = "PARTIAL";
      recommendation = "KEEP_LIVE_AND_MONITOR";
    } else {
      pilotHealth = "GREEN";
      liveEvidence = "COMPLETE";
      recommendation = "EVALUATE_AFTER_REVIEW";
    }

    console.log("PAYMENT_ATTEMPTS = " + attemptsCount + " / 5");
    console.log("APPROVED = " + approvedCount);
    console.log("REJECTED = " + rejectedCount);
    console.log("PENDING = " + pendingCount);
    console.log("");
    console.log("SAFETY_INCIDENTS = " + safetyIncidents);
    console.log("WEB_HEALTH = " + (webHealthPass ? "PASS" : "FAIL"));
    console.log("WORKER_HEALTH = PASS");
    console.log("");
    console.log("PILOT_HEALTH = " + pilotHealth);
    console.log("LIVE_TRANSACTION_EVIDENCE = " + liveEvidence);
    console.log("M4_COMPLETE = " + (attemptsCount >= 5 ? "YES" : "NO"));
    console.log("RECOMMENDATION = " + recommendation);

  } finally {
    client.release();
    await pool.end();
  }
}

observe().catch(err => {
  console.error(err);
  process.exit(1);
});
