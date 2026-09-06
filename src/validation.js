const { badRequest } = require("./errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = ["pending", "confirmed", "checked_in", "completed", "cancelled", "no_show", "rescheduled"];

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw badRequest(`${field} must be a valid uuid`);
  }
  return value;
}

function optionalUuid(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireUuid(value, field);
}

function requireDate(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw badRequest(`${field} must be YYYY-MM-DD`);
  }
  return value;
}

function requireTimestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw badRequest(`${field} must be a valid timestamp`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value).trim();
}

function requireStatus(value) {
  if (!BOOKING_STATUSES.includes(value)) {
    throw badRequest("status is invalid", { allowed: BOOKING_STATUSES });
  }
  return value;
}

function validateCreateBookingPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw badRequest("request body must be an object");
  }
  if (!payload.customer || typeof payload.customer !== "object") {
    throw badRequest("customer is required");
  }

  return {
    customer: {
      name: requireString(payload.customer.name, "customer.name"),
      phone: optionalString(payload.customer.phone),
      email: optionalString(payload.customer.email),
      line_user_id: optionalString(payload.customer.line_user_id),
      contact_channel: optionalString(payload.customer.contact_channel),
      notes: optionalString(payload.customer.notes)
    },
    service_id: requireUuid(payload.service_id, "service_id"),
    staff_id: requireUuid(payload.staff_id, "staff_id"),
    start_at: requireTimestamp(payload.start_at, "start_at"),
    source: optionalString(payload.source) ?? "web",
    notes: optionalString(payload.notes)
  };
}

module.exports = {
  optionalString,
  optionalUuid,
  requireDate,
  requireStatus,
  requireString,
  requireTimestamp,
  requireUuid,
  validateCreateBookingPayload
};
