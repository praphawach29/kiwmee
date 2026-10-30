// The customer's own booking (/b/<slug>/manage/<token>): see it, cancel it, or move it to another
// time, within the shop's rules (business_booking_settings.customer_*, migration …000900).
// The token is the customer's only key; the database keeps its sha256 and the RPCs check the
// shop's rules again, so this file only reads, words the answers, and passes the request on.

const crypto = require("node:crypto");
const { AppError, badRequest, notFound } = require("../errors");
const { findShop, loadCatalog } = require("./catalog-repository");
const { REASON_TEXT } = require("./reason-text");
const { getOptions, localToMs, msToLocal } = require("./options-engine");

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const OPEN = ["held", "pending", "confirmed"];


function rpcError(error) {
  const status = { BK409: 409, BK422: 422, BK404: 404 }[error?.code];
  if (!status) return error;
  return new AppError(status === 409 ? "CONFLICT" : status === 404 ? "NOT_FOUND" : "UNAVAILABLE", REASON_TEXT[error.message] ?? error.message, status, {
    reason: error.message
  });
}

/** A new link for a booking: the token goes to the customer, the hash to the database. */
function issueToken() {
  const token = crypto.randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}

function hashToken(token) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw notFound(REASON_TEXT.NOT_FOUND);
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function requireShop(db, slug) {
  const shop = await findShop(db, slug);
  if (!shop) throw notFound(REASON_TEXT.NOT_FOUND);
  return shop;
}

async function loadBooking(db, shop, token) {
  const { rows } = await db.query(
    `select b.id, b.status, b.start_at, b.end_at, b.party_size, b.hold_expires_at, b.offering_id,
            (b.price_snapshot->>'total')::float8 as price, o.name as offering_name, o.duration_mode, c.name as customer_name,
            coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind,
                                                        'picked', exists (select 1 from public.offering_requirements q
                                                                           where q.offering_id = b.offering_id and q.kind = r.kind and q.customer_picks))
                                      order by r.sort_order, r.name)
                        from public.booking_resources br join public.resources r on r.id = br.resource_id
                       where br.booking_id = b.id), '[]'::json) as resources,
            coalesce(s.customer_can_cancel, true) as can_cancel, coalesce(s.customer_can_reschedule, true) as can_reschedule,
            coalesce(s.customer_change_cutoff_hours, 2) as cutoff_hours
       from public.bookings b
       join public.offerings o on o.id = b.offering_id
       join public.customers c on c.id = b.customer_id
       left join public.business_booking_settings s on s.business_id = b.business_id
      where b.business_id = $1 and b.manage_token_hash = $2`,
    [shop.id, hashToken(token)]
  );
  if (!rows[0]) throw notFound(REASON_TEXT.NOT_FOUND);
  return rows[0];
}

/** What the page shows: the booking, and whether (and until when) the customer may change it. */
async function findManaged(db, slug, token, now = new Date()) {
  const shop = await requireShop(db, slug);
  const b = await loadBooking(db, shop, token);
  const start = msToLocal(new Date(b.start_at).getTime(), shop.timezone);
  const end = msToLocal(new Date(b.end_at).getTime(), shop.timezone);
  const deadline = new Date(new Date(b.start_at).getTime() - b.cutoff_hours * 3600 * 1000);
  const open = OPEN.includes(b.status) && !(b.status === "held" && new Date(b.hold_expires_at) <= now);
  const late = now > deadline;
  const why = (allowed) => (!open ? "NOT_CHANGEABLE" : !allowed ? "CUSTOMER_CHANGE_OFF" : late ? "TOO_LATE_TO_CHANGE" : null);
  const policy = (allowed) => {
    const reason = why(allowed);
    return { allowed: reason === null, reason, message: reason ? REASON_TEXT[reason] : null };
  };
  return {
    shop: { slug: shop.slug, name: shop.name, timezone: shop.timezone },
    booking: {
      status: b.status,
      date: start.date,
      start: start.time,
      end: end.time,
      startAt: b.start_at,
      partySize: b.party_size,
      price: b.price,
      holdExpiresAt: b.hold_expires_at,
      offering: { id: b.offering_id, name: b.offering_name },
      customerName: b.customer_name,
      resources: b.resources.map((r) => ({ name: r.name, kind: r.kind }))
    },
    cancel: policy(b.can_cancel),
    reschedule: policy(b.can_reschedule),
    cutoffHours: b.cutoff_hours,
    // the last moment the customer may change it, in the shop's time
    deadline: msToLocal(deadline.getTime(), shop.timezone)
  };
}

// The choices the customer made, so another time keeps the same service, stylist, length and party
function selectedFrom(b) {
  const picked = b.resources.find((r) => r.picked);
  const selected = { offeringId: b.offering_id, partySize: b.party_size };
  if (picked) selected.resourceId = picked.id;
  if (b.duration_mode === "customer_choice") selected.durationMinutes = Math.round((new Date(b.end_at) - new Date(b.start_at)) / 60000);
  return selected;
}

/** body = { ask: "date" } or { ask: "time", date } → other days / start times for the same booking */
async function manageOptions(db, slug, token, body = {}, now = new Date()) {
  const shop = await requireShop(db, slug);
  const b = await loadBooking(db, shop, token);
  if (body.ask !== "date" && body.ask !== "time") throw badRequest("ask must be date or time");
  const selected = selectedFrom(b);
  if (body.ask === "time") {
    if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw badRequest("date must be YYYY-MM-DD");
    selected.date = body.date;
  }
  const catalog = await loadCatalog(db, shop);
  if (!catalog.offerings.some((o) => o.id === b.offering_id)) return { ask: body.ask, options: [], reason: "NOT_OFFERED" };
  if (selected.resourceId && !catalog.resources.some((r) => r.id === selected.resourceId)) delete selected.resourceId;
  const result = getOptions(catalog, { ask: body.ask, selected, now, excludeBookingId: b.id });
  return {
    ask: body.ask,
    options: result.options.map((o) => ({ value: o.value, available: o.available, reason: o.reason })),
    reason: result.reason
  };
}

async function cancelManaged(db, slug, token, body = {}) {
  const shop = await requireShop(db, slug);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  try {
    await db.query("select public.customer_cancel_booking($1, $2, $3)", [shop.id, hashToken(token), reason || null]);
  } catch (error) {
    throw rpcError(error);
  }
  return findManaged(db, slug, token);
}

/** body = { date, time } in the shop's local time */
async function rescheduleManaged(db, slug, token, body = {}) {
  const shop = await requireShop(db, slug);
  if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw badRequest("date must be YYYY-MM-DD");
  if (typeof body.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw badRequest("time must be HH:MM");
  const startAt = new Date(localToMs(body.date, body.time, shop.timezone)).toISOString();
  try {
    await db.query("select public.customer_reschedule_booking($1, $2, $3)", [shop.id, hashToken(token), startAt]);
  } catch (error) {
    throw rpcError(error);
  }
  return findManaged(db, slug, token);
}

module.exports = { issueToken, hashToken, findManaged, manageOptions, cancelManaged, rescheduleManaged, REASON_TEXT };
