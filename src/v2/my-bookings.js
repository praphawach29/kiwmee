// "การจองของฉัน" (/b/<slug>/me): a customer who opens the shop inside LINE sees their own bookings
// at that shop — the next one first, then the others coming up, then the past. LINE proves who they
// are (the LIFF ID token, checked with LINE on every request); nothing else is needed, and nobody can
// see another person's bookings or another shop's.
//
// The button on each upcoming booking is the customer's own booking link (manage page), kept
// encrypted on the booking since migration …002300; older bookings have none and show no button.

const { AppError, notFound } = require("../errors");
const { findShop } = require("./catalog-repository");
const { verifyLineIdToken } = require("./public-booking");
const { openLink } = require("./line-notify");
const { msToLocal } = require("./options-engine");
const { directionsLink } = require("./directions");
const { memberCard, issueMemberCode } = require("./loyalty");

const UPCOMING = ["held", "pending", "confirmed", "checked_in"];
const PAST_LIMIT = 20;

/**
 * body = { lineIdToken }. verifyLineToken(token) → { sub } | null is injected so tests need no network.
 * Returns { shop, upcoming: [...], past: [...] }, each booking already in the shop's local time.
 */
async function myBookings(db, slug, body = {}, { now = new Date(), verifyLineToken = (token) => verifyLineIdToken(token, db), env = process.env } = {}) {
  const shop = await findShop(db, slug);
  if (!shop) throw notFound("ไม่พบร้าน");
  if (typeof body.lineIdToken !== "string" || !body.lineIdToken) throw new AppError("FORBIDDEN", "กรุณาเปิดจาก LINE เพื่อดูการจองของคุณ", 403);
  const line = await verifyLineToken(body.lineIdToken);
  if (!line?.sub) throw new AppError("FORBIDDEN", "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง", 403);

  const { rows } = await db.query(
    `select b.id, b.status, b.start_at, b.end_at, b.hold_expires_at, b.line_manage_token,
            (b.price_snapshot->>'total')::float8 as total, o.name as offering,
            coalesce((select json_agg(json_build_object('name', r.name, 'kind', r.kind) order by r.sort_order, r.name)
                        from public.booking_resources br join public.resources r on r.id = br.resource_id
                       where br.booking_id = b.id and br.addon_id is null), '[]'::json) as resources
       from public.bookings b
       join public.customers c on c.id = b.customer_id
       join public.offerings o on o.id = b.offering_id
      where b.business_id = $1 and c.business_id = $1 and c.line_user_id = $2
      order by b.start_at desc
      limit 100`,
    [shop.id, line.sub]
  );

  const at = now.getTime();
  const item = (b) => {
    // a hold that ran out is over, whatever the status still says
    const status = b.status === "held" && b.hold_expires_at && new Date(b.hold_expires_at).getTime() <= at ? "expired" : b.status;
    const start = msToLocal(new Date(b.start_at).getTime(), shop.timezone);
    const end = msToLocal(new Date(b.end_at).getTime(), shop.timezone);
    const upcoming = UPCOMING.includes(status) && new Date(b.end_at).getTime() > at;
    const token = upcoming ? openLink(b.id, b.line_manage_token, env) : null;
    return {
      upcoming,
      booking: {
        // what the check-in QR carries (the shop scans it at the desk; it opens nothing for anyone else)
        checkin: upcoming ? b.id : null,
        status,
        date: start.date,
        start: start.time,
        end: end.time,
        endDate: end.date,
        offering: b.offering,
        resources: b.resources,
        total: b.total ?? 0,
        link: token ? `/b/${shop.slug}/manage/${token}` : null
      }
    };
  };
  const all = rows.map(item);
  // the member's points at this shop's brand (migration …002800), when it runs a points programme
  const points = await memberCard(db, shop, line.sub).catch(() => null);
  return {
    points,
    shop: { slug: shop.slug, name: shop.name, directions: directionsLink({ address: shop.address, mapUrl: shop.map_url }) },
    // soonest first
    upcoming: all.filter((x) => x.upcoming).map((x) => x.booking).reverse(),
    // latest first
    past: all.filter((x) => !x.upcoming).map((x) => x.booking).slice(0, PAST_LIMIT)
  };
}

/** A 6-digit code to show at the counter (walk-in: the shop ties the bill to the member with it) */
async function myMemberCode(db, slug, body = {}, { verifyLineToken = (token) => verifyLineIdToken(token, db) } = {}) {
  const shop = await findShop(db, slug);
  if (!shop) throw notFound("ไม่พบร้าน");
  if (typeof body.lineIdToken !== "string" || !body.lineIdToken) throw new AppError("FORBIDDEN", "กรุณาเปิดจาก LINE", 403);
  const line = await verifyLineToken(body.lineIdToken);
  if (!line?.sub) throw new AppError("FORBIDDEN", "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง", 403);
  return issueMemberCode(db, shop, line.sub);
}

module.exports = { myBookings, myMemberCode };
