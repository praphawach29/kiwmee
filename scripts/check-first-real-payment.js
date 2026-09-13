const { Pool } = require("pg");

async function checkFirstRealPayment() {
  const activationTimestamp = "2026-09-13T11:06:24.000Z";
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const client = await pool.connect();

  try {
    const attempts = await client.query(
      "SELECT * FROM payment_attempts WHERE created_at >= $1 ORDER BY created_at ASC",
      [activationTimestamp]
    );

    const payments = await client.query(
      "SELECT * FROM payments WHERE created_at >= $1 ORDER BY created_at ASC",
      [activationTimestamp]
    );

    const events = await client.query(
      "SELECT * FROM payment_events WHERE created_at >= $1 ORDER BY created_at ASC",
      [activationTimestamp]
    );

    const bookings = await client.query(
      "SELECT id, status, created_at, updated_at FROM bookings WHERE created_at >= $1 ORDER BY created_at ASC",
      [activationTimestamp]
    );

    const webhooks = await client.query(
      "SELECT event_id, created_at FROM line_webhook_events WHERE created_at >= $1 ORDER BY created_at ASC",
      [activationTimestamp]
    );

    console.log("=== FIRST REAL PAYMENT AUDIT ===");
    console.log("Activation timestamp:", activationTimestamp);
    console.log("Current server time:", new Date().toISOString());
    console.log("payment_attempts count:", attempts.rows.length);
    console.log("payments count:", payments.rows.length);
    console.log("payment_events count:", events.rows.length);
    console.log("bookings count:", bookings.rows.length);
    console.log("line_webhook_events count:", webhooks.rows.length);

    if (attempts.rows.length === 0) {
      console.log("\nRESULT: No real payment attempts found after activation.");
      return { found: false };
    }

    console.log("\nFirst Attempt Details:", attempts.rows[0]);
    console.log("Associated Payment:", payments.rows[0]);
    return { found: true, attempt: attempts.rows[0], payment: payments.rows[0] };
  } finally {
    client.release();
    await pool.end();
  }
}

checkFirstRealPayment().catch(err => {
  console.error(err);
  process.exit(1);
});
