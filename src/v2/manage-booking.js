// The customer's own booking (/b/<slug>/manage/<token>): see it, cancel it, or move it to another
// time, within the shop's rules (business_booking_settings.customer_*, migration …000900).
// The token is the customer's only key; the database keeps its sha256 and the RPCs check the
// shop's rules again, so this file only reads, words the answers, and passes the request on.

const crypto = require("node:crypto");
const { AppError, badRequest, notFound } = require("../errors");
const { findShop, loadCatalog } = require("./catalog-repository");
const { REASON_TEXT } = require("./reason-text");
const { getOptions, localToMs, msToLocal } = require("./options-engine");
const { promptPayQr } = require("./promptpay");
const { directionsLink } = require("./directions");
const { documentStatus, submitDocument } = require("./rental-documents");
const { heldReward } = require("./loyalty");
const { checkSlip } = require("./slip-check");

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
            (b.price_snapshot->>'total')::float8 as price, o.name as offering_name, o.duration_mode, coalesce(b.customer_name, c.name) as customer_name,
            coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name, 'kind', r.kind,
                                                        'picked', exists (select 1 from public.offering_requirements q
                                                                           where q.offering_id = b.offering_id and q.kind = r.kind and q.customer_picks))
                                      order by r.sort_order, r.name)
                        from public.booking_resources br join public.resources r on r.id = br.resource_id
                       where br.booking_id = b.id and br.addon_id is null), '[]'::json) as resources,
            coalesce((select json_agg(json_build_object('id', ba.addon_id, 'name', ba.name, 'quantity', ba.quantity,
                                                        'total', ba.total, 'adds_minutes', ad.adds_minutes) order by ba.name)
                        from public.booking_addons ba join public.addons ad on ad.id = ba.addon_id
                       where ba.booking_id = b.id), '[]'::json) as addons,
            coalesce(s.customer_can_cancel, true) as can_cancel, coalesce(s.customer_can_reschedule, true) as can_reschedule,
            coalesce(s.customer_change_cutoff_hours, 2) as cutoff_hours,
            b.deposit_due::float8 as deposit_due, coalesce(s.payment_info, '{}'::jsonb) as payment_info,
            (select count(*)::int from public.payment_slips ps where ps.booking_id = b.id) as slips
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
  // still to pay: a PromptPay QR with the deposit filled in, when the shop takes PromptPay
  const qr = b.deposit_due !== null && b.status === "held" && open ? await promptPayQr(b.payment_info?.promptPay, b.deposit_due).catch(() => null) : null;
  // the documents a rental asks for (design 11.7 E3), while the booking is still on
  const documents = OPEN.includes(b.status) ? await documentStatus(db, b.id) : null;
  // points set aside for a reward when booking (migration …003200)
  const points = OPEN.includes(b.status) ? await heldReward(db, b.id).catch(() => null) : null;
  return {
    documents,
    points,
    shop: { slug: shop.slug, name: shop.name, timezone: shop.timezone, address: shop.address ?? "", directions: directionsLink({ address: shop.address, mapUrl: shop.map_url }) },
    booking: {
      // what the check-in QR carries (the shop scans it at the desk; it opens nothing for anyone else)
      // only once the booking counts (a deposit still awaited: no QR yet)
      checkin: ["confirmed", "checked_in"].includes(b.status) ? b.id : null,
      status: b.status,
      date: start.date,
      start: start.time,
      end: end.time,
      endDate: end.date, // a rental over several days comes back on a later day
      startAt: b.start_at,
      partySize: b.party_size,
      price: b.price,
      holdExpiresAt: b.hold_expires_at,
      offering: { id: b.offering_id, name: b.offering_name },
      customerName: b.customer_name,
      resources: b.resources.map((r) => ({ name: r.name, kind: r.kind })),
      addons: b.addons.map((a) => ({ name: a.name, quantity: a.quantity, total: Number(a.total) })),
      // a deposit to transfer (held), or a slip the shop has not looked at yet (pending)
      deposit: b.deposit_due !== null
        ? { due: b.deposit_due, slips: b.slips, ...(b.price > 0 && b.deposit_due >= b.price ? { payFull: true } : {}), paymentInfo: ["held", "pending"].includes(b.status) ? b.payment_info : null, ...(qr ? { qr } : {}) }
        : null
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
  const extra = b.addons.reduce((sum, a) => sum + (a.adds_minutes || 0) * a.quantity, 0);
  if (["customer_choice", "days"].includes(b.duration_mode)) selected.durationMinutes = Math.round((new Date(b.end_at) - new Date(b.start_at)) / 60000) - extra;
  // the add-ons move with the booking, so the new time must have room for them too
  if (b.addons.length) selected.addons = Object.fromEntries(b.addons.map((a) => [a.id, a.quantity]));
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
  // an add-on the shop has since switched off still moves with the booking, but cannot be checked here
  if (selected.addons) {
    selected.addons = Object.fromEntries(Object.entries(selected.addons).filter(([id]) => catalog.addons.some((a) => a.id === id)));
  }
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

/** The customer's transfer slip (already decoded and re-encoded as WebP by the route) */
/**
 * The customer's slip. With a slip-reading key set (/super), it is checked at once (src/v2/slip-check.js)
 * and, if the shop lets passing slips confirm by themselves, the booking may come back confirmed.
 * jpeg: the same picture as JPEG for the reading service. check: injectable for tests.
 */
async function submitSlip(db, slug, token, image, { jpeg = null, check = checkSlip, onConfirmed = null } = {}) {
  const shop = await requireShop(db, slug);
  const tokenHash = hashToken(token);
  try {
    await db.query("select public.customer_submit_slip($1, $2, $3)", [shop.id, tokenHash, image]);
  } catch (error) {
    throw rpcError(error);
  }
  let slipCheck = null;
  if (jpeg) {
    const { rows: [slip] } = await db.query(
      `select s.id from public.payment_slips s join public.bookings b on b.id = s.booking_id
        where b.business_id = $1 and b.manage_token_hash = $2 order by s.created_at desc limit 1`,
      [shop.id, tokenHash]
    );
    if (slip) slipCheck = await check(db, slip.id, jpeg, { onConfirmed });
  }
  const view = await findManaged(db, slug, token);
  return slipCheck ? { ...view, slipCheck: { status: slipCheck.status, confirmed: slipCheck.confirmed, reasons: slipCheck.reasons } } : view;
}

/** The customer's rental document (re-encoded WebP by the route) with their consent */
async function submitManagedDocument(db, slug, token, input, options) {
  const shop = await requireShop(db, slug);
  try {
    await submitDocument(db, shop, hashToken(token), input, options);
  } catch (error) {
    throw error.status ? error : rpcError(error);
  }
  return findManaged(db, slug, token);
}

module.exports = { submitManagedDocument, issueToken, hashToken, findManaged, manageOptions, cancelManaged, rescheduleManaged, submitSlip, REASON_TEXT };
