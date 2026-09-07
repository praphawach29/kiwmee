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
const { getPilotConfig, validateRuntimeConfig } = require("../src/config");

const INTERVAL_MS = readPositiveInteger("AUTOMATION_SCHEDULE_INTERVAL_MS", 60000, 5000);
const MAX_CONSECUTIVE_FAILURES = readPositiveInteger("AUTOMATION_MAX_CONSECUTIVE_FAILURES", 5, 1);
let running = false;
let isTerminating = false;
let consecutiveFailures = 0;

validateRuntimeConfig();

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
    consecutiveFailures = 0;

    console.log(JSON.stringify({
      event: "automation_scheduler_cycle",
      timestamp: new Date().toISOString(),
      duration_ms: elapsed,
      detected_no_shows: result.no_show_detected,
      shadow_mode: result.shadow_mode,
      processed_jobs: result.jobs_processed,
      failed_jobs: result.jobs?.filter((j) => j.status === "failed").length || 0
    }));
  } catch (error) {
    consecutiveFailures += 1;
    console.error(JSON.stringify({
      event: "automation_scheduler_error",
      timestamp: new Date().toISOString(),
      error: error.message,
      consecutive_failures: consecutiveFailures
    }));
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(JSON.stringify({
        event: "automation_scheduler_fatal",
        timestamp: new Date().toISOString(),
        reason: "maximum consecutive failures reached"
      }));
      process.exitCode = 1;
      await shutdown("FAILURE_THRESHOLD");
    }
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
  process.exit(process.exitCode ?? 0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function readPositiveInteger(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}
