// Rental documents (migration …002700, design 11.7 E3): the customer's ID card / driving licence /
// passport photo for a rental, under the PDPA. The picture is re-encoded by the route (no EXIF/GPS),
// encrypted here (AES-256-GCM, SETTINGS_ENCRYPTION_KEY, bound to the booking and the kind) and only
// then stored. Only the shop's members can read the row, only the server can decrypt it, and it is
// deleted automatically some days after the rental ends, or at once when the booking is called off.

const crypto = require("node:crypto");
const { AppError, notFound } = require("../errors");
const { masterKey } = require("./platform-settings");

const DOCUMENT_KINDS = ["id_card", "driving_license", "passport"];
const DOCUMENT_LABEL = { id_card: "บัตรประชาชน", driving_license: "ใบขับขี่", passport: "พาสปอร์ต" };

function keyOf(env) {
  const key = masterKey(env);
  if (!key) throw new AppError("NOT_CONFIGURED", "ร้านนี้ยังรับเอกสารไม่ได้ (ระบบยังไม่ได้ตั้งกุญแจเข้ารหัส) กรุณาติดต่อร้าน", 503);
  return key;
}

const aad = (bookingId, kind) => Buffer.from(`booking-document:${bookingId}:${kind}`);

/** iv 12 · tag 16 · ciphertext */
function sealDocument(bookingId, kind, bytes, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(env), iv);
  cipher.setAAD(aad(bookingId, kind));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openDocument(bookingId, kind, sealed, env = process.env) {
  const raw = Buffer.from(sealed);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyOf(env), raw.subarray(0, 12));
  decipher.setAAD(aad(bookingId, kind));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

function kindOf(value) {
  if (!DOCUMENT_KINDS.includes(value)) throw new AppError("INVALID", "ชนิดเอกสารไม่ถูกต้อง", 422);
  return value;
}

/**
 * The customer's upload from their booking link. consent must be true: they agreed to the shop keeping
 * it for this rental and to when it is deleted. image = the re-encoded WebP bytes.
 */
async function submitDocument(db, shop, tokenHash, { kind, consent, image }, { env = process.env } = {}) {
  kindOf(kind);
  if (consent !== true) throw new AppError("CONSENT_REQUIRED", "กรุณายืนยันความยินยอมก่อนส่งเอกสาร", 422);
  const { rows: [b] } = await db.query("select id from public.bookings where business_id = $1 and manage_token_hash = $2", [shop.id, tokenHash]);
  if (!b) throw notFound("ไม่พบการจองนี้ ลิงก์อาจไม่ถูกต้อง");
  const sealed = sealDocument(b.id, kind, image, env);
  await db.query("select public.customer_submit_document($1, $2, $3, $4)", [shop.id, tokenHash, kind, sealed]);
}

/** What the customer's page shows: which documents the service asks for, which are in, the rule */
async function documentStatus(db, bookingId) {
  const { rows: [b] } = await db.query(
    `select o.required_documents, coalesce(s.document_retention_days, 30) as days,
            coalesce((select json_agg(json_build_object('kind', d.kind, 'at', d.created_at, 'reviewed', d.reviewed_at is not null) order by d.kind)
                        from public.booking_documents d where d.booking_id = b.id), '[]'::json) as uploaded
       from public.bookings b join public.offerings o on o.id = b.offering_id
       left join public.business_booking_settings s on s.business_id = b.business_id
      where b.id = $1`,
    [bookingId]
  );
  if (!b || b.required_documents.length === 0) return null;
  return {
    required: b.required_documents.map((kind) => ({ kind, label: DOCUMENT_LABEL[kind] })),
    uploaded: b.uploaded.map((d) => ({ kind: d.kind, at: d.at, reviewed: d.reviewed })),
    retentionDays: b.days
  };
}

// ---------- the shop (signed-in member, row level security) ----------

/** The documents of a booking, without the pictures */
async function listDocuments(client, shop, bookingId) {
  const { rows } = await client.query(
    `select id, kind, consent_at, delete_after, reviewed_at, created_at from public.booking_documents
      where business_id = $1 and booking_id = $2 order by kind`,
    [shop.id, bookingId]
  );
  return rows.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: DOCUMENT_LABEL[d.kind],
    consentAt: d.consent_at,
    deleteAfter: d.delete_after,
    reviewedAt: d.reviewed_at,
    createdAt: d.created_at
  }));
}

/** One picture, decrypted, for a member to look at (the route sends it with no-store) */
async function readDocument(client, shop, id, { env = process.env } = {}) {
  const { rows: [d] } = await client.query(
    "select booking_id, kind, sealed from public.booking_documents where id = $1 and business_id = $2",
    [id, shop.id]
  );
  if (!d) throw notFound("ไม่พบเอกสาร (อาจถูกลบตามกำหนดแล้ว)");
  return { image: openDocument(d.booking_id, d.kind, d.sealed, env), mime: "image/webp" };
}

async function reviewDocument(client, shop, id) {
  const { rowCount } = await client.query(
    "update public.booking_documents set reviewed_at = now(), reviewed_by = auth.uid() where id = $1 and business_id = $2",
    [id, shop.id]
  );
  if (!rowCount) throw notFound("ไม่พบเอกสาร");
  return { id, reviewed: true };
}

async function deleteDocument(client, shop, id) {
  const { rowCount } = await client.query("delete from public.booking_documents where id = $1 and business_id = $2", [id, shop.id]);
  if (!rowCount) throw notFound("ไม่พบเอกสาร");
  return { id, deleted: true };
}

// ---------- deletion on schedule (the server's own connection) ----------

/** Past their keep-until date, or the booking was called off: gone. Returns how many. */
async function purgeDocuments(db, now = new Date()) {
  const { rowCount } = await db.query(
    `delete from public.booking_documents d
      where d.delete_after < $1
         or exists (select 1 from public.bookings b where b.id = d.booking_id and b.status in ('cancelled', 'expired'))`,
    [now.toISOString()]
  );
  return rowCount;
}

let timer = null;
function startDocumentPurge(getDb, { everyMs = 60 * 60 * 1000 } = {}) {
  if (timer) return timer;
  const tick = () => purgeDocuments(getDb()).then((n) => n && console.log(`[rental-documents] deleted ${n}`)).catch((e) => console.error("[rental-documents] purge failed:", e.message));
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
  return timer;
}

module.exports = {
  DOCUMENT_KINDS,
  DOCUMENT_LABEL,
  sealDocument,
  openDocument,
  submitDocument,
  documentStatus,
  listDocuments,
  readDocument,
  reviewDocument,
  deleteDocument,
  purgeDocuments,
  startDocumentPurge
};
