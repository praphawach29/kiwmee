#!/usr/bin/env node

/**
 * Salon Booking OS v1 — Pilot #1 Pre-flight Verification Script
 * 
 * Verifies system readiness before Pilot launch:
 * 1. Node runtime compatibility
 * 2. Environment configuration completeness (via src/config.js)
 * 3. Database connectivity and required table schemas (if DATABASE_URL is set)
 * 4. Seed data presence (active services, staff, availability)
 * 
 * Usage:
 *   node scripts/pilot-preflight.js
 */

const { getPilotConfig, getBookingConfig, validateRuntimeConfig } = require("../src/config");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

async function runPreflight() {
  console.log(`${CYAN}====================================================${RESET}`);
  console.log(`${CYAN}  Salon Booking OS v1 — Pilot #1 Pre-flight Checks  ${RESET}`);
  console.log(`${CYAN}====================================================${RESET}\n`);

  let failures = 0;
  let warnings = 0;

  // 1. Check Node.js Version
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    console.log(`${RED}✖ [FAIL] Node.js version is ${process.version}. Requires Node.js >= 20.${RESET}`);
    failures++;
  } else {
    console.log(`${GREEN}✔ [PASS] Node.js version is ${process.version} (>= 20 required)${RESET}`);
  }

  // 2. Validate Runtime Configuration
  console.log(`\nChecking runtime configuration...`);
  try {
    const config = validateRuntimeConfig(process.env);
    console.log(`${GREEN}✔ [PASS] Runtime configuration is valid for production/pilot.${RESET}`);
    console.log(`  - Business Name: ${config.businessName}`);
    console.log(`  - Timezone: ${config.timezone}`);
    console.log(`  - AI Provider: ${config.aiEnabled ? config.aiProvider : "disabled"}`);
    console.log(`  - LINE Integration: ${config.lineEnabled ? "enabled" : "disabled"}`);
  } catch (err) {
    if (err.code === "CONFIG_INVALID") {
      console.log(`${RED}✖ [FAIL] Invalid production configuration:${RESET}`);
      const issues = err.message.replace("Invalid production configuration: ", "").split("; ");
      issues.forEach((issue) => console.log(`    - ${issue}`));
      failures++;
    } else {
      console.log(`${RED}✖ [FAIL] Error validating config: ${err.message}${RESET}`);
      failures++;
    }
  }

  // 3. Database Connectivity & Schema Verification
  console.log(`\nChecking PostgreSQL database connectivity and tables...`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log(`${YELLOW}⚠ [WARN] DATABASE_URL is not set in current environment.${RESET}`);
    console.log(`  Set DATABASE_URL to verify database tables and pilot seed data.`);
    warnings++;
  } else {
    const { Client } = require("pg");
    const client = new Client({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
    });

    try {
      await client.connect();
      console.log(`${GREEN}✔ [PASS] Database connection established successfully.${RESET}`);

      // Verify all required tables exist
      const requiredTables = [
        "services",
        "staff",
        "staff_services",
        "availability",
        "bookings",
        "booking_status_history",
        "automation_jobs",
        "automation_logs",
        "ai_sessions",
        "rate_limits",
        "handoff_requests",
        "admin_session_revocations",
        "line_webhook_events"
      ];

      const res = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      const existingTables = new Set(res.rows.map((r) => r.table_name));

      const missingTables = requiredTables.filter((table) => !existingTables.has(table));
      if (missingTables.length > 0) {
        console.log(`${RED}✖ [FAIL] Missing required database tables:${RESET}`);
        missingTables.forEach((t) => console.log(`    - ${t}`));
        console.log(`  Run: psql "$DATABASE_URL" -f database/schema.sql`);
        failures++;
      } else {
        console.log(`${GREEN}✔ [PASS] All ${requiredTables.length} required database tables exist.${RESET}`);

        // Verify Pilot Seed Data
        const servicesCount = await client.query("SELECT COUNT(*) FROM services WHERE active = true");
        const staffCount = await client.query("SELECT COUNT(*) FROM staff WHERE active = true");
        const availCount = await client.query("SELECT COUNT(*) FROM availability WHERE type = 'available'");

        const activeServices = Number(servicesCount.rows[0].count);
        const activeStaff = Number(staffCount.rows[0].count);
        const activeSlots = Number(availCount.rows[0].count);

        console.log(`\nVerifying Pilot Seed Data:`);
        console.log(`  - Active Services: ${activeServices}`);
        console.log(`  - Active Staff: ${activeStaff}`);
        console.log(`  - Availability Shifts: ${activeSlots}`);

        if (activeServices === 0 || activeStaff === 0) {
          console.log(`${YELLOW}⚠ [WARN] No active services or staff found. Please run seed data:${RESET}`);
          console.log(`  psql "$DATABASE_URL" -f pilot/database/pilot_salon_seed.sql`);
          warnings++;
        } else {
          console.log(`${GREEN}✔ [PASS] Salon services and staff are seeded and active.${RESET}`);
        }
      }
    } catch (dbErr) {
      console.log(`${RED}✖ [FAIL] Database connection error: ${dbErr.message}${RESET}`);
      failures++;
    } finally {
      await client.end().catch(() => {});
    }
  }

  // Summary
  console.log(`\n${CYAN}----------------------------------------------------${RESET}`);
  if (failures === 0 && warnings === 0) {
    console.log(`${GREEN}✔ ALL PRE-FLIGHT CHECKS PASSED. Ready for Pilot #1 Launch!${RESET}`);
    process.exit(0);
  } else if (failures === 0) {
    console.log(`${YELLOW}✔ PRE-FLIGHT COMPLETED WITH ${warnings} WARNING(S). Review warnings before launch.${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}✖ PRE-FLIGHT FAILED WITH ${failures} ERROR(S) AND ${warnings} WARNING(S). Resolve before launch.${RESET}`);
    process.exit(1);
  }
}

runPreflight().catch((err) => {
  console.error("Fatal pre-flight error:", err);
  process.exit(1);
});
