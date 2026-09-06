#!/usr/bin/env node

/**
 * Salon Booking OS v1 — Production Automation Runner Scheduler
 * 
 * Runs the automation cycle periodically (default: every 60 seconds).
 * Processes due confirmation, reminder, cancellation, no-show detection, and follow-up jobs.
 * 
 * Usage:
 *   node scripts/automation-scheduler.js
 */

const { getRepository, closeRepository } = require("../src/repositories");
const { runAutomationCycle } = require("../src/automation/automation-service");
const { createNotificationProvider } = require("../src/automation/provider-factory");
const { getPilotConfig } = require("../src/config");

const INTERVAL_MS = Number(process.env.AUTOMATION_SCHEDULE_INTERVAL_MS || 60000); // 1 minute default
let running = false;
let isTerminating = false;

async function executeCycle() {
  if (running || isTerminating) return;
  running = true;
  const start = Date.now();

  try {
    const repository = getRepository();
    const config = getPilotConfig();
    const provider = createNotificationProvider(repository, config);

    const result = await runAutomationCycle(repository, { provider });
    const elapsed = Date.now() - start;

    console.log(JSON.stringify({
      event: "automation_scheduler_cycle",
      timestamp: new Date().toISOString(),
      duration_ms: elapsed,
      detected_no_shows: result.detectedNoShows?.length || 0,
      processed_jobs: result.jobs?.length || 0,
      failed_jobs: result.jobs?.filter((j) => j.status === "failed").length || 0
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "automation_scheduler_error",
      timestamp: new Date().toISOString(),
      error: error.message
    }));
  } finally {
    running = false;
  }
}

console.log(JSON.stringify({
  event: "automation_scheduler_started",
  timestamp: new Date().toISOString(),
  interval_seconds: Math.floor(INTERVAL_MS / 1000)
}));

// Run immediately on startup, then on interval
executeCycle();
const timer = setInterval(executeCycle, INTERVAL_MS);

// Graceful shutdown handling
async function shutdown(signal) {
  if (isTerminating) return;
  isTerminating = true;
  clearInterval(timer);
  console.log(JSON.stringify({
    event: "automation_scheduler_stopping",
    timestamp: new Date().toISOString(),
    signal
  }));

  try {
    await closeRepository();
    await require("../src/repositories/pilot").closePilotRepository();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
