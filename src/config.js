const DEFAULT_CANCELLATION_WINDOW_HOURS = 24;
const DEFAULT_REMINDER_HOURS_BEFORE = 24;
const DEFAULT_NO_SHOW_GRACE_MINUTES = 15;
const DEFAULT_NO_SHOW_FOLLOWUP_HOURS = 1;
const DEFAULT_POST_SERVICE_FOLLOWUP_HOURS = 24;
const DEFAULT_BOOKING_MIN_LEAD_MINUTES = 15;

function getBookingConfig(env = process.env) {
  return {
    automationMaxAttempts: Math.max(1, Math.floor(readPositiveNumber(env.AUTOMATION_MAX_ATTEMPTS, 5))),
    automationRetryBaseSeconds: readPositiveNumber(env.AUTOMATION_RETRY_BASE_SECONDS, 60),
    cancellationWindowHours: readPositiveNumber(
      env.CANCELLATION_WINDOW_HOURS,
      DEFAULT_CANCELLATION_WINDOW_HOURS
    ),
    reminderHoursBefore: readPositiveNumber(
      env.REMINDER_HOURS_BEFORE,
      DEFAULT_REMINDER_HOURS_BEFORE
    ),
    noShowGraceMinutes: readPositiveNumber(
      env.NO_SHOW_GRACE_MINUTES,
      DEFAULT_NO_SHOW_GRACE_MINUTES
    ),
    noShowFollowupHours: readPositiveNumber(
      env.NO_SHOW_FOLLOWUP_HOURS,
      DEFAULT_NO_SHOW_FOLLOWUP_HOURS
    ),
    postServiceFollowupHours: readPositiveNumber(
      env.POST_SERVICE_FOLLOWUP_HOURS,
      DEFAULT_POST_SERVICE_FOLLOWUP_HOURS
    ),
    bookingMinLeadMinutes: readPositiveNumber(
      env.BOOKING_MIN_LEAD_MINUTES,
      DEFAULT_BOOKING_MIN_LEAD_MINUTES
    ),
    automationInternalSecret: env.AUTOMATION_INTERNAL_SECRET ?? null
  };
}

const { DEFAULT_SINGLE_BUSINESS_ID } = require("./licensing/providers/static-provider");

function getPilotConfig(env = process.env) {
  return {
    businessId: env.BUSINESS_ID ?? DEFAULT_SINGLE_BUSINESS_ID,
    businessName: env.BUSINESS_NAME ?? "Salon Booking OS",
    timezone: env.BUSINESS_TIMEZONE ?? "Asia/Bangkok",
    businessContact: env.BUSINESS_CONTACT ?? "",
    handoffDestination: env.HANDOFF_DESTINATION ?? env.BUSINESS_CONTACT ?? "",
    aiEnabled: readBoolean(env.AI_ENABLED, true),
    aiProvider: env.AI_PROVIDER ?? "mock",
    aiModel: env.AI_MODEL ?? "gpt-5.4-mini",
    openaiApiKey: env.OPENAI_API_KEY ?? null,
    lineEnabled: readBoolean(env.LINE_ENABLED, false),
    lineChannelSecret: env.LINE_CHANNEL_SECRET ?? null,
    lineAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN ?? null,
    adminSessionHours: readPositiveNumber(env.ADMIN_SESSION_HOURS, 8)
  };
}

function validateRuntimeConfig(env = process.env) {
  const config = getPilotConfig(env); const errors = [];
  const required = (name, minimum = 1) => { if (!env[name] || env[name].length < minimum) errors.push(`${name} is required${minimum > 1 ? ` and must contain at least ${minimum} characters` : ""}`); };
  required("DATABASE_URL"); required("BUSINESS_NAME"); required("BUSINESS_CONTACT");
  required("ADMIN_PASSWORD_HASH"); required("ADMIN_SESSION_SECRET", 32); required("AUTOMATION_INTERNAL_SECRET", 32);
  try { new Intl.DateTimeFormat("en", { timeZone: config.timezone }).format(); } catch { errors.push("BUSINESS_TIMEZONE is invalid"); }
  if (!/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/i.test(env.ADMIN_PASSWORD_HASH ?? "")) errors.push("ADMIN_PASSWORD_HASH must be a scrypt hash");
  if (config.aiEnabled && config.aiProvider === "openai") { required("OPENAI_API_KEY", 20); required("AI_MODEL"); }
  if (!['mock', 'openai'].includes(config.aiProvider)) errors.push("AI_PROVIDER must be mock or openai");
  if (config.lineEnabled) { required("LINE_CHANNEL_SECRET", 16); required("LINE_CHANNEL_ACCESS_TOKEN", 20); }
  if (errors.length) { const error = new Error(`Invalid production configuration: ${errors.join("; ")}`); error.code = "CONFIG_INVALID"; throw error; }
  return config;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function readPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }

  return number;
}

function getBusinessPaymentPolicy(env = process.env) {
  if (env.BUSINESS_PAYMENT_POLICY) {
    try {
      const parsed = JSON.parse(env.BUSINESS_PAYMENT_POLICY);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore
    }
  }

  if (env.BUSINESS_PAYMENT_TYPE) {
    return {
      payment_type: env.BUSINESS_PAYMENT_TYPE,
      fixed_amount: readPositiveNumber(env.BUSINESS_PAYMENT_FIXED_AMOUNT, 200),
      currency: env.BUSINESS_PAYMENT_CURRENCY || "THB"
    };
  }

  return null;
}

module.exports = {
  DEFAULT_BOOKING_MIN_LEAD_MINUTES,
  DEFAULT_CANCELLATION_WINDOW_HOURS,
  DEFAULT_NO_SHOW_FOLLOWUP_HOURS,
  DEFAULT_NO_SHOW_GRACE_MINUTES,
  DEFAULT_POST_SERVICE_FOLLOWUP_HOURS,
  DEFAULT_REMINDER_HOURS_BEFORE,
  getBookingConfig,
  getPilotConfig,
  getBusinessPaymentPolicy,
  validateRuntimeConfig
};
