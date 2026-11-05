// GET /api/health — one place that answers "is this deployment serving bookings right now?"
//
// The first version pinged the v1 database (DATABASE_URL through getPilotRepository), which the
// Railway service no longer has: production answered 503 "degraded" while every booking, bill and
// LINE card worked. Health must check the database this app actually uses (booking-v2 through
// BOOKING_DB_URL) and say what the customer-facing features depend on.

const LINE_SETTINGS = ["line.liff_id", "line.login_channel_id", "line.messaging_access_token"];

const CHECK_TIMEOUT_MS = 3000;

// A hung pool must not hang the health check: overloaded or paused databases answer 503, not nothing.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function databaseState(query, timeoutMs) {
  try {
    await withTimeout(query("select 1"), timeoutMs);
    return "ready";
  } catch {
    return "unavailable";
  }
}

// The LINE keys live in platform_settings when the owner sets them from /super, so environment
// variables alone would report "not configured" for a working setup. Only the count is read —
// the values are encrypted and must never leave the settings module.
async function lineState(query, timeoutMs) {
  try {
    const result = await withTimeout(
      query("select count(*)::int as n from public.platform_settings where key = any($1)", [LINE_SETTINGS]),
      timeoutMs,
    );
    const count = result?.rows?.[0]?.n ?? 0;
    return count > 0 ? "configured" : "not_configured";
  } catch {
    return "unknown";
  }
}

function commitOf(env) {
  const sha = env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;
}

async function healthReport({ query, env = process.env, reminders = null, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const [database, line] = await Promise.all([
    typeof query === "function" ? databaseState(query, timeoutMs) : Promise.resolve("unavailable"),
    typeof query === "function" ? lineState(query, timeoutMs) : Promise.resolve("unknown"),
  ]);

  return {
    status: database === "ready" ? "ok" : "degraded",
    database,
    line,
    reminders: {
      enabled: env.LINE_REMINDERS !== "off",
      lastRunAt: reminders?.lastRunAt ?? null,
      lastError: reminders?.lastError ?? null,
    },
    commit: commitOf(env),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { healthReport, withTimeout, LINE_SETTINGS };
