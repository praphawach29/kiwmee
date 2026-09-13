// Salon Booking OS v1 - Provider Data Safety
// Sanitizes incoming vendor/provider payloads before storage in payment_attempts
// or event logs. Prevents sensitive secrets/credentials from being persisted.

const SENSITIVE_KEYS = new Set([
  "key",
  "apikey",
  "api_key",
  "secret",
  "secretkey",
  "secret_key",
  "authorization",
  "bearer",
  "token",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "privatekey",
  "private_key",
  "banksecret",
  "bank_secret",
  "clientsecret",
  "client_secret",
  "signature_secret",
  "channel_secret"
]);

/**
 * Deeply sanitizes an object by redacting any sensitive credential keys.
 */
function sanitizePayload(data, depth = 0) {
  if (depth > 8 || data === null || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizePayload(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase().replace(/[-_]/g, "");
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes("secret") || lowerKey.includes("token")) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizePayload(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Sanitizes payment attempt data before database insertion.
 * Ensures verified_receiver/sender are non-sensitive and provider raw responses are stripped of credentials.
 */
function sanitizePaymentAttempt(attempt) {
  if (!attempt) return {};

  const clean = { ...attempt };

  // Sanitize receiver and sender strings if present
  if (clean.verified_receiver) {
    clean.verified_receiver = String(clean.verified_receiver).trim().slice(0, 100);
  }
  if (clean.verified_sender) {
    clean.verified_sender = String(clean.verified_sender).trim().slice(0, 100);
  }

  // Sanitize metadata / raw provider response
  if (clean.raw_provider_response) {
    clean.raw_provider_response = sanitizePayload(clean.raw_provider_response);
  }
  if (clean.metadata) {
    clean.metadata = sanitizePayload(clean.metadata);
  }

  return clean;
}

/**
 * Sanitizes incoming vendor/provider response payload before storing.
 * Redacts credentials, masks full account numbers, and strips unnecessary PII.
 */
function sanitizeProviderData(data) {
  if (!data || typeof data !== "object") return data;

  const sanitized = sanitizePayload(data);

  // Recursively mask full account numbers and citizen IDs if found
  function maskSensitiveValues(obj) {
    if (!obj || typeof obj !== "object") return obj;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        const digits = v.replace(/[^0-9]/g, "");
        // If looks like full 10-12 digit account number, mask middle digits
        if (digits.length >= 10 && digits.length <= 12 && !v.includes("xxx")) {
          obj[k] = `xxx-x-xx${digits.slice(-4, -1)}-${digits.slice(-1)}`;
        }
        // If looks like 13-digit Thai national ID
        else if (digits.length === 13 && !v.includes("xxx")) {
          obj[k] = `x-xxxx-xxxx-${digits.slice(-4)}`;
        }
      } else if (typeof v === "object" && v !== null) {
        maskSensitiveValues(v);
      }
    }
    return obj;
  }

  return maskSensitiveValues(sanitized);
}

module.exports = {
  sanitizePayload,
  sanitizePaymentAttempt,
  sanitizeProviderData
};
