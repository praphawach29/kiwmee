const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, randomBytes, scryptSync } = require("node:crypto");
const { OpenAIProvider, MockAIProvider, createAIProvider } = require("../src/ai/provider");
const { LineMessagingProvider, MockMessagingProvider } = require("../src/messaging/providers");
const { LineAutomationNotificationProvider } = require("../src/messaging/line-automation-provider");
const { PhoneMatchVerificationProvider, VerificationProvider } = require("../src/security/verification");
const { validateRuntimeConfig } = require("../src/config");
const { logEvent } = require("../src/observability/logger");

test("AI provider factory retains deterministic Mock when real provider is disabled", async () => {
  const provider = createAIProvider({ aiProvider: "mock" });
  assert.ok(provider instanceof MockAIProvider);
  assert.deepEqual(await provider.interpret({ message: "บริการ", state: { stage: "start" } }), { intent: "services" });
});

test("OpenAI provider uses forced strict structured tool calling and maps failures safely", async () => {
  let request;
  const provider = new OpenAIProvider({ apiKey: "server-secret-key", model: "test-model", fetch: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ type: "function_call", name: "select_receptionist_action",
      arguments: '{"intent":"services","value":null}' }] }) };
  } });
  assert.deepEqual(await provider.interpret({ message: "มีบริการอะไร", state: { stage: "start" } }), { intent: "services", value: null });
  assert.equal(request.store, false); assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.tool_choice, { type: "function", name: "select_receptionist_action" });
  const failed = new OpenAIProvider({ apiKey: "x", model: "m", fetch: async () => { throw new Error("OPENAI_API_KEY=private"); } });
  await assert.rejects(failed.interpret({ message: "x", state: { stage: "start" } }), (error) =>
    error.code === "AI_PROVIDER_UNAVAILABLE" && !error.message.includes("private"));
});

test("LINE signature verification rejects invalid values and accepts the raw signed body", () => {
  const secret = "line-secret-for-tests"; const raw = Buffer.from('{"events":[]}');
  const provider = new LineMessagingProvider({ channelSecret: secret, accessToken: "token", fetch: async () => ({ ok: true }) });
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(provider.verifySignature(raw, signature), true);
  assert.equal(provider.verifySignature(Buffer.from("changed"), signature), false);
  assert.equal(provider.verifySignature(raw, "invalid"), false);
});

test("LINE automation provider resolves recipient without changing automation business logic", async () => {
  const messaging = new MockMessagingProvider();
  const provider = new LineAutomationNotificationProvider({ getBookingDetail: async () => ({ customer: { line_user_id: "U123" } }) }, messaging);
  await provider.sendConfirmation({ booking_id: "booking", start_at: "2026-09-10T10:00:00+07:00" });
  assert.equal(messaging.pushes.length, 1); assert.equal(messaging.pushes[0].to, "U123");
});

test("verification stays behind a provider abstraction", async () => {
  const provider = new PhoneMatchVerificationProvider();
  assert.ok(provider instanceof VerificationProvider);
  const repository = { getBookingDetail: async () => ({ customer: { phone: "081-234-5678" } }) };
  assert.equal(await provider.verifyBooking({ repository, bookingId: "id", proof: { phone: "0812345678" } }), true);
  assert.equal(await provider.verifyBooking({ repository, bookingId: "id", proof: { phone: "0899999999" } }), false);
});

test("production config validates required secrets and conditional providers", () => {
  assert.throws(() => validateRuntimeConfig({ PILOT_STRICT_CONFIG: "true" }), /DATABASE_URL/);
  const salt = randomBytes(16).toString("hex");
  const base = { DATABASE_URL: "postgresql://db", BUSINESS_NAME: "Beauty", BUSINESS_CONTACT: "02-000-0000",
    ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync("strong-password", salt, 32).toString("hex")}`,
    ADMIN_SESSION_SECRET: "a".repeat(32), AUTOMATION_INTERNAL_SECRET: "b".repeat(32),
    AI_ENABLED: "false", AI_PROVIDER: "mock", LINE_ENABLED: "false", BUSINESS_TIMEZONE: "Asia/Bangkok" };
  assert.equal(validateRuntimeConfig(base).businessName, "Beauty");
  assert.throws(() => validateRuntimeConfig({ ...base, AI_ENABLED: "true", AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  assert.throws(() => validateRuntimeConfig({ ...base, LINE_ENABLED: "true" }), /LINE_CHANNEL_SECRET/);
});

test("structured logger only emits allowlisted metadata", () => {
  let output = "";
  logEvent("handoff_created", { session_id: "session", phone: "0812345678", message: "private", secret: "token" }, (line) => { output = line; });
  assert.match(output, /handoff_created/); assert.doesNotMatch(output, /0812345678|private|token/);
});
