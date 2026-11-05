const test = require("node:test");
const assert = require("node:assert/strict");
const { healthReport, withTimeout } = require("../src/v2/health");

// The health endpoint pings booking-v2 (BOOKING_DB_URL), not the retired v1 database: production
// used to answer 503 while every booking worked.

function fakeQuery({ fail = false, hang = false, lineSettings = 0 } = {}) {
  return async (sql) => {
    if (hang) return new Promise(() => {});
    if (fail) throw new Error("connection refused");
    if (/platform_settings/.test(sql)) return { rows: [{ n: lineSettings }] };
    return { rows: [{ "?column?": 1 }] };
  };
}

test("a reachable booking database reports ok", async () => {
  const report = await healthReport({ query: fakeQuery(), env: {} });
  assert.equal(report.status, "ok");
  assert.equal(report.database, "ready");
  assert.equal(report.line, "not_configured");
  assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("an unreachable database reports degraded with 503 semantics", async () => {
  const report = await healthReport({ query: fakeQuery({ fail: true }), env: {} });
  assert.equal(report.status, "degraded");
  assert.equal(report.database, "unavailable");
});

test("a hung database is reported degraded instead of hanging the health check", async () => {
  const started = Date.now();
  const report = await healthReport({ query: fakeQuery({ hang: true }), env: {}, timeoutMs: 40 });
  assert.equal(report.status, "degraded");
  assert.ok(Date.now() - started < 1000, "must give up after timeoutMs");
});

test("LINE counts as configured when the owner saved keys in /super", async () => {
  const report = await healthReport({ query: fakeQuery({ lineSettings: 3 }), env: {} });
  assert.equal(report.line, "configured");
});

test("a missing platform_settings table does not lie about LINE", async () => {
  const report = await healthReport({
    query: async (sql) => {
      if (/platform_settings/.test(sql)) throw new Error('relation "platform_settings" does not exist');
      return { rows: [] };
    },
    env: {},
  });
  assert.equal(report.status, "ok");
  assert.equal(report.line, "unknown");
});

test("the report never carries secrets from the environment", async () => {
  const env = {
    LINE_CHANNEL_ACCESS_TOKEN: "super-secret-token",
    LINE_CHANNEL_SECRET: "super-secret-channel",
    EASYSLIP_API_KEY: "super-secret-slip",
    SETTINGS_ENCRYPTION_KEY: "super-secret-key",
  };
  const text = JSON.stringify(await healthReport({ query: fakeQuery(), env }));
  for (const secret of Object.values(env)) assert.equal(text.includes(secret), false, secret);
});

test("the deployment commit is shortened for humans", async () => {
  const report = await healthReport({
    query: fakeQuery(),
    env: { RAILWAY_GIT_COMMIT_SHA: "d675b3a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7" },
  });
  assert.equal(report.commit, "d675b3a");
  assert.equal((await healthReport({ query: fakeQuery(), env: {} })).commit, null);
});

test("the reminder clock reports its last run so a stopped clock is visible", async () => {
  const reminders = { started: true, lastRunAt: "2026-11-05T04:55:00.000Z", lastError: null };
  const report = await healthReport({ query: fakeQuery(), env: {}, reminders });
  assert.equal(report.reminders.lastRunAt, reminders.lastRunAt);
  assert.equal(report.reminders.enabled, true);
  const off = await healthReport({ query: fakeQuery(), env: { LINE_REMINDERS: "off" } });
  assert.equal(off.reminders.enabled, false);
});

test("the route answers 503 instead of throwing when the booking database is not configured", async () => {
  const saved = process.env.BOOKING_DB_URL;
  delete process.env.BOOKING_DB_URL;
  try {
    const { GET } = require("../app/api/health/route");
    const response = await GET();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).database, "unavailable");
  } finally {
    if (saved === undefined) delete process.env.BOOKING_DB_URL;
    else process.env.BOOKING_DB_URL = saved;
  }
});

test("withTimeout rejects instead of leaking a pending promise", async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /TIMEOUT/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 20), "ok");
});
