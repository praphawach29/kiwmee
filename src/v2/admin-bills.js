// Bills (docs/LOYALTY_DESIGN.md §5, step 6d): the shop closes a booking's bill after the visit, or
// rings up a walk-in sale with no booking, and sees what came in each day.
//
// Like admin-bookings.js, every function takes a client already running as the signed-in user:
// RLS limits reads to the user's shops and the bill RPCs (migration …001000) check membership
// again. Staff may close bills; only owners refund (the route asks for an owner, the RPC too).

const { AppError, badRequest, notFound } = require("../errors");
const { REASON_TEXT: BOOKING_REASONS } = require("./admin-bookings");
const { localToMs, msToLocal } = require("./options-engine");

const DAY_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ["cash", "transfer", "card", "online"];

const REASON_TEXT = {
  ...BOOKING_REASONS,
  NOT_CHANGEABLE: "บิล/การจองนี้เปลี่ยนแบบนี้ไม่ได้แล้ว",
  ALREADY_CLOSED: "บิลนี้ปิดไปแล้ว",
  PAYMENT_MISMATCH: "ยอดที่รับไม่ตรงกับยอดที่ต้องชำระ",
  INVALID_PAYMENT: "ช่องทางหรือยอดชำระไม่ถูกต้อง",
  INVALID_AMOUNT: "ยอดเงินไม่ถูกต้อง",
  REFUND_TOO_MUCH: "คืนเงินเกินยอดที่รับไว้",
  HAS_PAYMENTS: "บิลนี้มีการรับเงินแล้ว ใช้คืนเงินแทน",
  BILL_CLOSED: "การจองนี้ปิดบิลแล้ว ย้อนสถานะไม่ได้ (ใช้คืนเงินแทน)",
  NOT_FOUND: "ไม่พบรายการนี้"
};

function rpcError(error) {
  const status = { BK409: 409, BK422: 422, BK404: 404 }[error?.code];
  if (!status) return error;
  return new AppError(status === 404 ? "NOT_FOUND" : "UNAVAILABLE", REASON_TEXT[error.message] ?? error.message, status, { reason: error.message });
}

async function rpc(client, sql, params) {
  try {
    return (await client.query(sql, params)).rows[0];
  } catch (error) {
    throw rpcError(error);
  }
}

const invalid = (message) => new AppError("INVALID", message, 422);

function amount(value, label) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 10_000_000) throw invalid(`${label}ไม่ถูกต้อง`);
  return Math.round(n * 100) / 100;
}

function text(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** [{ method, amount }] — lines of 0 are dropped (the form starts with an empty line) */
function payments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) throw invalid("รายการชำระเงินไม่ถูกต้อง");
  return value
    .map((p) => {
      if (!METHODS.includes(p?.method)) throw invalid("เลือกช่องทางชำระเงิน");
      return { method: p.method, amount: amount(p.amount, "ยอดชำระ") };
    })
    .filter((p) => p.amount > 0);
}

function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("วันที่ต้องเป็น YYYY-MM-DD");
  return value;
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function billView(row, shop) {
  const at = row.closed_at ?? row.created_at;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    customerName: row.customer_name,
    bookingId: row.booking_id,
    subtotal: num(row.subtotal),
    discount: num(row.discount),
    total: num(row.total),
    paid: num(row.paid),
    refunded: num(row.refunded),
    note: row.note,
    time: msToLocal(new Date(at).getTime(), shop.timezone).time,
    payments: (row.payments ?? []).map((p) => ({ kind: p.kind, method: p.method, amount: num(p.amount), note: p.note }))
  };
}

/** The day's bills and what came in, by method (refunds made that day are taken off). */
async function listBills(client, shop, { from } = {}) {
  const fromMs = localToMs(date(from), "00:00", shop.timezone);
  const range = [shop.id, new Date(fromMs).toISOString(), new Date(fromMs + DAY_MS).toISOString()];
  const { rows } = await client.query(
    `select b.id, b.status, b.title, b.booking_id, b.subtotal, b.discount, b.total, b.note, b.closed_at, b.created_at,
            coalesce(b.customer_name, c.name) as customer_name,
            coalesce((select sum(p.amount) from public.bill_payments p where p.bill_id = b.id and p.kind <> 'refund'), 0) as paid,
            coalesce((select sum(p.amount) from public.bill_payments p where p.bill_id = b.id and p.kind = 'refund'), 0) as refunded,
            coalesce((select json_agg(json_build_object('kind', p.kind, 'method', p.method, 'amount', p.amount, 'note', p.note) order by p.created_at)
                        from public.bill_payments p where p.bill_id = b.id), '[]'::json) as payments
       from public.bills b
       left join public.customers c on c.id = b.customer_id
      where b.business_id = $1 and b.status <> 'void'
        and coalesce(b.closed_at, b.created_at) >= $2 and coalesce(b.closed_at, b.created_at) < $3
      order by coalesce(b.closed_at, b.created_at) desc`,
    range
  );
  const sums = await client.query(
    `select kind, method, sum(amount) as amount from public.bill_payments
      where business_id = $1 and created_at >= $2 and created_at < $3 group by kind, method`,
    range
  );
  const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  let refunds = 0;
  for (const s of sums.rows) {
    if (s.kind === "refund") refunds += num(s.amount);
    else byMethod[s.method] += num(s.amount);
  }
  const received = METHODS.reduce((t, m) => t + byMethod[m], 0);
  const bills = rows.map((r) => billView(r, shop));
  return {
    bills,
    summary: {
      byMethod,
      received: Math.round(received * 100) / 100,
      refunds: Math.round(refunds * 100) / 100,
      net: Math.round((received - refunds) * 100) / 100,
      closedBills: bills.filter((b) => b.status === "closed").length
    }
  };
}

async function closeOpened(client, billId, input, subtotal) {
  const row = await rpc(client, "select public.close_bill($1, $2::jsonb, $3, $4) as bill", [
    billId,
    JSON.stringify(payments(input.payments)),
    subtotal,
    text(input.note, 300)
  ]);
  return row.bill;
}

/** A walk-in sale: { title?, customerName?, amount, payments, note? } opened and closed at once. */
async function createSale(client, shop, input = {}) {
  const subtotal = amount(input.amount, "ยอดขาย");
  const opened = await rpc(client, "select public.open_bill($1, null, $2, $3, $4) as id", [
    shop.id,
    text(input.title, 100),
    subtotal,
    text(input.customerName, 100)
  ]);
  return closeOpened(client, opened.id, input, null);
}

/** Close a booking's bill: { subtotal?, payments, note? }. The booking becomes completed. */
async function checkoutBooking(client, shop, bookingId, input = {}) {
  if (typeof bookingId !== "string" || !UUID.test(bookingId)) throw notFound("ไม่พบการจองนี้");
  const opened = await rpc(client, "select public.open_bill($1, $2) as id", [shop.id, bookingId]);
  const subtotal = input.subtotal === undefined || input.subtotal === null || input.subtotal === "" ? null : amount(input.subtotal, "ยอดรวม");
  return closeOpened(client, opened.id, input, subtotal);
}

async function ownBill(client, shop, id) {
  if (typeof id !== "string" || !UUID.test(id)) throw notFound("ไม่พบบิลนี้");
  const { rows } = await client.query("select id from public.bills where id = $1 and business_id = $2", [id, shop.id]);
  if (!rows[0]) throw notFound("ไม่พบบิลนี้");
}

/** { amount, method, reason? } — owners only */
async function refundBill(client, shop, id, input = {}) {
  await ownBill(client, shop, id);
  if (!METHODS.includes(input.method)) throw badRequest("เลือกช่องทางคืนเงิน");
  const row = await rpc(client, "select public.refund_bill($1, $2, $3, $4) as bill", [
    id,
    amount(input.amount, "ยอดคืนเงิน"),
    input.method,
    text(input.reason, 200)
  ]);
  return row.bill;
}

module.exports = { listBills, createSale, checkoutBooking, refundBill, METHODS, REASON_TEXT };
