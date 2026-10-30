// The shop's bookings page (app/dashboard/[slug], "การจอง"): see the day's bookings, take a phone
// or walk-in booking, record one afterwards, move, cancel, and mark arrivals, finished visits and
// no-shows.
//
// Like admin-catalog.js, every function takes a client already running as the signed-in user, so
// RLS limits reads to the user's shops and the booking RPCs check membership again. Staff members
// may use all of this (front desk work); only the catalog is owner-only.

const { AppError, badRequest, notFound } = require("../errors");
const { loadCatalog } = require("./catalog-repository");
const { getOptions, localToMs, msToLocal } = require("./options-engine");

const DAY_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THAI_PHONE = /^0\d{8,9}$/;
const STATUSES = ["checked_in", "completed", "no_show", "confirmed"];
const PAST_STATUSES = ["completed", "checked_in", "no_show"];

// What the booking RPCs answer (BK409 / BK422 / BK404 with a reason code), for the shop to read
const REASON_TEXT = {
  FULLY_BOOKED: "ช่วงเวลานี้มีการจองแล้ว",
  HOLD_EXPIRED: "การจองนี้หมดเวลารอชำระเงินแล้ว",
  BUSINESS_CLOSED: "ร้านปิดในวันหรือช่วงเวลานั้น",
  STAFF_OFF: "ช่าง/สนามที่เลือกไม่อยู่ช่วงเวลานั้น",
  NOT_OFFERED: "ช่าง/สนามที่เลือกไม่ได้ทำบริการนี้",
  NO_WORKING_WINDOW: "เวลานี้อยู่นอกเวลาทำการ หรือนอกเวลาทำงานของช่าง/สนาม",
  PAST_WORKING_HOURS: "เลยเวลาที่รับจองแล้ว",
  OUTSIDE_BOOKING_WINDOW: "เวลานี้ผ่านไปแล้ว หรือไกลกว่าที่ร้านเปิดให้จองล่วงหน้า",
  INVALID_TIME: "เวลาเริ่มไม่ตรงกับช่วงเวลาของร้าน",
  INVALID_DURATION: "ระยะเวลาไม่ถูกต้องสำหรับบริการนี้",
  INVALID_PARTY_SIZE: "จำนวนคนเกินที่บริการนี้รับได้",
  CUSTOMER_NAME_REQUIRED: "กรุณากรอกชื่อลูกค้า",
  NOT_IN_PAST: "เวลานี้ยังไม่ถึง บันทึกเป็นการจองปกติแทน",
  BILL_CLOSED: "การจองนี้ปิดบิลแล้ว ย้อนสถานะไม่ได้ (ใช้คืนเงินแทน)",
  NOT_CHANGEABLE: "การจองนี้เปลี่ยนสถานะแบบนี้ไม่ได้แล้ว",
  NOT_FOUND: "ไม่พบการจองนี้"
};

function rpcError(error) {
  const status = { BK409: 409, BK422: 422, BK404: 404 }[error?.code];
  if (!status) return error;
  return new AppError(error.code === "BK409" ? "CONFLICT" : "UNAVAILABLE", REASON_TEXT[error.message] ?? error.message, status, { reason: error.message });
}

async function rpc(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (error) {
    throw rpcError(error);
  }
}

const invalid = (message) => new AppError("INVALID", message, 422);

function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("วันที่ต้องเป็น YYYY-MM-DD");
  return value;
}

function time(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid("เวลาต้องเป็น HH:MM");
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest(`${label}ไม่ถูกต้อง`);
  return value;
}

function optionalInt(value, label, max = 1440) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`${label}ไม่ถูกต้อง`);
  return n;
}

const startAt = (shop, d, t) => new Date(localToMs(date(d), time(t), shop.timezone)).toISOString();

async function ownBooking(client, shop, id) {
  if (typeof id !== "string" || !UUID.test(id)) throw notFound("ไม่พบการจองนี้");
  const { rows } = await client.query("select id from public.bookings where id = $1 and business_id = $2", [id, shop.id]);
  if (!rows[0]) throw notFound("ไม่พบการจองนี้");
}

/** Bookings that start on `from` (shop's local date) and the `days - 1` days after it. */
async function listBookings(client, shop, { from, days = 1 } = {}) {
  const fromMs = localToMs(date(from), "00:00", shop.timezone);
  const n = Math.min(Math.max(Number(days) || 1, 1), 31);
  const { rows } = await client.query(
    `select b.id, b.status, b.start_at, b.end_at, b.party_size, b.source, b.notes, b.hold_expires_at,
            (b.price_snapshot->>'total')::float8 as price, b.offering_id, o.name as offering_name,
            coalesce(b.customer_name, c.name) as customer_name, c.phone as customer_phone, c.line_user_id is not null as from_line,
            (select h.reason from public.booking_status_history h where h.booking_id = b.id
              order by h.created_at desc, (h.to_status = b.status) desc limit 1) as status_reason,
            (select json_build_object('id', bl.id, 'status', bl.status, 'total', bl.total,
                                      'paid', coalesce((select sum(p.amount) from public.bill_payments p where p.bill_id = bl.id and p.kind <> 'refund'), 0))
               from public.bills bl where bl.booking_id = b.id and bl.status <> 'void') as bill,
            coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind) order by r.sort_order, r.name)
                        from public.booking_resources br join public.resources r on r.id = br.resource_id
                       where br.booking_id = b.id), '[]'::json) as resources
       from public.bookings b
       join public.offerings o on o.id = b.offering_id
       join public.customers c on c.id = b.customer_id
      where b.business_id = $1 and b.start_at >= $2 and b.start_at < $3
      order by b.start_at, coalesce(b.customer_name, c.name)`,
    [shop.id, new Date(fromMs).toISOString(), new Date(fromMs + n * DAY_MS).toISOString()]
  );
  return rows.map((b) => {
    const start = msToLocal(new Date(b.start_at).getTime(), shop.timezone);
    const end = msToLocal(new Date(b.end_at).getTime(), shop.timezone);
    return {
      id: b.id,
      status: b.status,
      date: start.date,
      start: start.time,
      end: end.time,
      startAt: b.start_at,
      endAt: b.end_at,
      partySize: b.party_size,
      source: b.source,
      notes: b.notes,
      statusReason: b.status_reason,
      bill: b.bill ? { id: b.bill.id, status: b.bill.status, total: Number(b.bill.total), paid: Number(b.bill.paid) } : null,
      holdExpiresAt: b.hold_expires_at,
      price: b.price,
      offering: { id: b.offering_id, name: b.offering_name },
      customer: { name: b.customer_name, phone: b.customer_phone, fromLine: b.from_line },
      resources: b.resources
    };
  });
}

/** Start times that are free for this offering on this day (a helper for the shop's forms). */
async function freeTimes(client, shop, query = {}, now = new Date()) {
  const offeringId = optionalId(query.offeringId, "บริการ");
  if (!offeringId) throw invalid("เลือกบริการก่อน");
  const catalog = await loadCatalog(client, shop);
  const selected = { offeringId, date: date(query.date) };
  const resourceId = optionalId(query.resourceId, "ช่าง/สนาม");
  if (resourceId) selected.resourceId = resourceId;
  const duration = optionalInt(query.durationMinutes, "ระยะเวลา");
  if (duration) selected.durationMinutes = duration;
  const party = optionalInt(query.partySize, "จำนวนคน", 1000);
  if (party) selected.partySize = party;
  const result = getOptions(catalog, { ask: "time", selected, now, excludeBookingId: optionalId(query.excludeBookingId, "การจอง") ?? undefined });
  return { times: result.options.map((o) => o.value), reason: result.reason };
}

/**
 * A booking the shop takes itself (phone call, walk-in): no lead time, any start minute.
 * A start time that has already passed records the visit afterwards, as `status` (completed by
 * default, or checked_in / no_show), up to a year back.
 */
async function createBooking(client, shop, input = {}, now = new Date()) {
  const name = typeof input.customer?.name === "string" ? input.customer.name.trim().slice(0, 100) : "";
  const phone = typeof input.customer?.phone === "string" ? input.customer.phone.replace(/[\s-]/g, "") : "";
  if (!name) throw invalid("กรุณากรอกชื่อลูกค้า");
  if (phone && !THAI_PHONE.test(phone)) throw invalid("เบอร์โทรต้องเป็นตัวเลข 9–10 หลัก ขึ้นต้นด้วย 0");
  const offeringId = optionalId(input.offeringId, "บริการ");
  if (!offeringId) throw invalid("เลือกบริการ");
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 500) : null;
  const start = startAt(shop, input.date, input.time);
  if (new Date(start) < now) {
    const status = input.status ?? "completed";
    if (!PAST_STATUSES.includes(status)) throw badRequest("สถานะไม่ถูกต้อง");
    const past = await rpc(client, "select public.record_past_booking($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) as booking", [
      shop.id,
      offeringId,
      start,
      JSON.stringify({ name, phone: phone || null }),
      status,
      optionalId(input.resourceId, "ช่าง/สนาม"),
      optionalInt(input.durationMinutes, "ระยะเวลา"),
      optionalInt(input.partySize, "จำนวนคน", 1000) ?? 1,
      notes
    ]);
    return { id: past.booking.id, status };
  }
  const row = await rpc(
    client,
    "select public.create_booking($1, $2, $3, $4::jsonb, $5, $6, $7, false, 'admin', $8) as booking",
    [
      shop.id,
      offeringId,
      start,
      JSON.stringify({ name, phone: phone || null }),
      optionalId(input.resourceId, "ช่าง/สนาม"),
      optionalInt(input.durationMinutes, "ระยะเวลา"),
      optionalInt(input.partySize, "จำนวนคน", 1000) ?? 1,
      notes
    ]
  );
  return { id: row.booking.id, status: row.booking.status };
}

async function rescheduleBooking(client, shop, id, input = {}) {
  await ownBooking(client, shop, id);
  await rpc(client, "select public.reschedule_booking($1, $2, $3, $4, 'admin') as booking", [
    id,
    startAt(shop, input.date, input.time),
    optionalId(input.resourceId, "ช่าง/สนาม"),
    optionalInt(input.durationMinutes, "ระยะเวลา")
  ]);
  return { id };
}

async function cancelBooking(client, shop, id, input = {}) {
  await ownBooking(client, shop, id);
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 200) : "ยกเลิกโดยร้าน";
  await rpc(client, "select public.cancel_booking($1, $2) as booking", [id, reason]);
  return { id };
}

async function setStatus(client, shop, id, input = {}) {
  await ownBooking(client, shop, id);
  if (!STATUSES.includes(input.status)) throw badRequest("สถานะไม่ถูกต้อง");
  await rpc(client, "select public.set_booking_status($1, $2) as booking", [id, input.status]);
  return { id, status: input.status };
}

module.exports = { listBookings, freeTimes, createBooking, rescheduleBooking, cancelBooking, setStatus, REASON_TEXT };
