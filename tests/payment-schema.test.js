// Salon Booking OS v1 - Payment Schema Static Verification Test Suite
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_PATH = path.join(__dirname, "../database/migrations/007_payment_schema.sql");
const SCHEMA_PATH = path.join(__dirname, "../database/schema.sql");
const AVAILABILITY_ENGINE_PATH = path.join(__dirname, "../src/availability-engine.js");

test("007_payment_schema.sql exists and is readable", () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), "Migration file 007_payment_schema.sql must exist");
  const content = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.ok(content.length > 500, "Migration file must contain substantial SQL statements");
});

test("007_payment_schema.sql defines all 6 required dormant payment tables", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const requiredTables = [
    "payments",
    "payment_allocations",
    "payment_attempts",
    "payment_events",
    "refunds",
    "business_integrations"
  ];

  for (const table of requiredTables) {
    const tableRegex = new RegExp(`create table if not exists ${table}\\s*\\(`, "i");
    assert.match(sql, tableRegex, `Table ${table} must be defined with CREATE TABLE IF NOT EXISTS`);
  }
});

test("007_payment_schema.sql provides replay protection via compound unique index on transaction namespace and reference", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const uniqueIndexRegex = /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+payments\s*\(\s*transaction_namespace\s*,\s*transaction_reference\s*\)\s+where\s+transaction_reference\s+is\s+not\s+null/i;
  assert.match(sql, uniqueIndexRegex, "Must contain compound unique index on (transaction_namespace, transaction_reference) WHERE transaction_reference IS NOT NULL");
});

test("007_payment_schema.sql enforces idempotency keys on payments and refunds", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /idempotency_key\s+text\s+not\s+null\s+unique/i, "payments must have unique idempotency_key");
  
  const refundsTableMatch = sql.match(/create table if not exists refunds\s*\(([\s\S]*?)\);/i);
  assert.ok(refundsTableMatch, "refunds table definition found");
  assert.match(refundsTableMatch[1], /idempotency_key\s+text\s+not\s+null\s+unique/i, "refunds must have unique idempotency_key");
});

test("007_payment_schema.sql forbids plaintext secrets and uses credential_reference", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  
  const forbiddenKeywords = [
    "secretKey",
    "secret_key",
    "accessToken",
    "access_token",
    "webhookSecret",
    "webhook_secret",
    "apiKey",
    "api_key",
    "privateKey",
    "private_key"
  ];

  for (const kw of forbiddenKeywords) {
    const columnDefRegex = new RegExp(`^\\s*${kw}\\s+[a-z]+`, "im");
    assert.ok(!columnDefRegex.test(sql), `Plaintext secret column '${kw}' is strictly forbidden in schema`);
  }

  const bizTableMatch = sql.match(/create table if not exists business_integrations\s*\(([\s\S]*?)\);/i);
  assert.ok(bizTableMatch, "business_integrations table definition found");
  assert.match(bizTableMatch[1], /credential_reference\s+text\s+not\s+null/i, "business_integrations must use credential_reference");
});

test("007_payment_schema.sql defines payment_allocations with required fields and types", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const allocMatch = sql.match(/create table if not exists payment_allocations\s*\(([\s\S]*?)\);/i);
  assert.ok(allocMatch, "payment_allocations table definition found");
  const allocBody = allocMatch[1];

  assert.match(allocBody, /payment_id\s+uuid\s+not\s+null\s+references\s+payments/i, "payment_id FK");
  assert.match(allocBody, /booking_id\s+uuid\s+not\s+null\s+references\s+bookings/i, "booking_id FK");
  assert.match(allocBody, /amount\s+numeric\(10,\s*2\)\s+not\s+null\s+check\s*\(\s*amount\s*>\s*0\s*\)/i, "amount > 0 check");
  assert.match(allocBody, /allocation_type\s+text\s+not\s+null/i, "allocation_type exists");
  assert.match(allocBody, /'initial'/i, "allocation_type includes initial");
  assert.match(allocBody, /'reschedule_transfer'/i, "allocation_type includes reschedule_transfer");
  assert.match(allocBody, /'refund_release'/i, "allocation_type includes refund_release");
  assert.match(allocBody, /'manual_adjustment'/i, "allocation_type includes manual_adjustment");
  assert.match(allocBody, /status\s+text\s+not\s+null\s+default\s+'active'/i, "status default active");
  assert.match(allocBody, /'active'/i, "status includes active");
  assert.match(allocBody, /'released'/i, "status includes released");
  assert.match(allocBody, /'transferred'/i, "status includes transferred");
  assert.match(allocBody, /'refunded'/i, "status includes refunded");
});

test("007_payment_schema.sql enforces deterministic currency format", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const currencyMatch = sql.match(/currency\s+varchar\(3\)\s+not\s+null\s+default\s+'THB'\s+check\s*\(\s*currency\s*~\s*'(\^\[A-Z\]\{3\}\$)'\s*\)/i);
  assert.ok(currencyMatch, "payments.currency must be varchar(3) default 'THB' with uppercase 3-letter regex check");
});

test("007_payment_schema.sql documents append-only invariant for payment_events", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /payment_events\s+\(Append-only audit ledger\)/i, "payment_events header documents append-only audit ledger");
  assert.match(sql, /NEVER\s+UPDATE\s+or\s+DELETE/i, "Schema comments explicitly forbid UPDATE and DELETE on payment_events");
});

test("007_payment_schema.sql documents original_booking_id and payment_allocations semantics", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /original_booking_id[\s\S]*MUST NEVER be rewritten/i, "Comments document that original_booking_id is immutable across reschedules");
  assert.match(sql, /authoritative[\s\S]*source of truth[\s\S]*payment_allocations/i, "Comments document that payment_allocations is current allocation source of truth");
});

test("007_payment_schema.sql defines payments with verification grace support (expires_at and verification_deadline)", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const paymentsMatch = sql.match(/create table if not exists payments\s*\(([\s\S]*?)\);/i);
  assert.ok(paymentsMatch, "payments table definition found");
  const paymentsBody = paymentsMatch[1];

  assert.match(paymentsBody, /expires_at\s+timestamptz\s+not\s+null/i, "expires_at required for payment expiry window");
  assert.match(paymentsBody, /verification_deadline\s+timestamptz/i, "verification_deadline for grace window during verification");
  assert.match(paymentsBody, /original_booking_id\s+uuid\s+not\s+null\s+references\s+bookings/i, "original_booking_id immutable link");
});

test("007_payment_schema.sql enforces financial validity constraints", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

  assert.match(sql, /amount_due\s+numeric\(10,\s*2\)\s+not\s+null\s+check\s*\(\s*amount_due\s*>=\s*0\s*\)/i);
  assert.match(sql, /amount_paid\s+numeric\(10,\s*2\)\s+not\s+null\s+default\s+0\s+check\s*\(\s*amount_paid\s*>=\s*0\s*\)/i);

  const refundsMatch = sql.match(/create table if not exists refunds\s*\(([\s\S]*?)\);/i);
  assert.match(refundsMatch[1], /amount\s+numeric\(10,\s*2\)\s+not\s+null\s+check\s*\(\s*amount\s*>\s*0\s*\)/i);
});

test("007_payment_schema.sql safely expands bookings_status_check to include 'expired'", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sql, /alter table bookings drop constraint if exists bookings_status_check;/i);
  assert.match(
    sql,
    /alter table bookings add constraint bookings_status_check\s+check\s*\(\s*status in \('pending','confirmed','checked_in','completed','cancelled','no_show','rescheduled','expired'\)\);/i
  );
});

test("'expired' status is excluded from GiST double-booking constraint and active availability statuses", () => {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  const gistMatch = schemaSql.match(/exclude using gist\s*\([\s\S]*?where\s*\(\s*status\s+in\s*\(([\s\S]*?)\)\s*\)/i);
  assert.ok(gistMatch, "GiST exclusion constraint found in database/schema.sql");
  assert.ok(!gistMatch[1].includes("'expired'"), "GiST active statuses must NOT include 'expired'");

  const availabilitySrc = fs.readFileSync(AVAILABILITY_ENGINE_PATH, "utf8");
  const activeStatusesMatch = availabilitySrc.match(/ACTIVE_BOOKING_STATUSES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(activeStatusesMatch, "ACTIVE_BOOKING_STATUSES found in src/availability-engine.js");
  assert.ok(!activeStatusesMatch[1].includes("expired"), "ACTIVE_BOOKING_STATUSES must NOT include 'expired'");
});

test("007_payment_schema.sql enables RLS on all 6 tables without permissive public policies (Fail-Closed)", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const tables = [
    "payments",
    "payment_allocations",
    "payment_attempts",
    "payment_events",
    "refunds",
    "business_integrations"
  ];

  for (const table of tables) {
    const rlsRegex = new RegExp(`alter table ${table} enable row level security;`, "i");
    assert.match(sql, rlsRegex, `RLS must be enabled on ${table}`);
  }

  // Ensure no CREATE POLICY ... TO anon or public exists
  const publicPolicyRegex = /create\s+policy\s+[\s\S]*?to\s+(?:anon|public)\s+using/i;
  assert.ok(!publicPolicyRegex.test(sql), "Migration must not create permissive public/anon policies");
});
