// Appointment reminders in LINE (migration …002300): the day before (24 hours) and 2 hours before,
// for confirmed bookings made inside LINE at shops that keep reminders on. The server runs
// sendDueReminders every few minutes (instrumentation.js); a reminder is claimed in
// booking_reminders before it is sent, so two servers or a restart never send it twice.
//
// A reminder is skipped when the booking was made after its moment (booked 10 hours ahead: no
// day-before card, the confirmation card just went out), and a moved booking is reminded again.

const { publicOrigin, checkinImageUrl, bookingCode } = require("./scan-codes");
const { bookingCard, manageLink, openLink, pushLine } = require("./line-notify");
const { sendExpiryNotices } = require("./loyalty-expiry");
const { directionsLink } = require("./directions");

const KINDS = [
  // kind, from (before the start), until (before the start)
  { kind: "day", from: "24 hours", until: "3 hours", card: "remind_day" },
  { kind: "soon", from: "2 hours", until: "0 minutes", card: "remind_soon" }
];

async function dueReminders(db, now, limit) {
  const { rows } = await db.query(
    `select b.id, b.business_id, k.kind, b.start_at, b.end_at, (b.price_snapshot->>'total')::float8 as total, b.line_manage_token,
            o.name as offering, c.line_user_id, biz.name as shop_name, biz.slug, biz.timezone, biz.address, biz.map_url,
            coalesce((select array_agg(r.name order by r.sort_order, r.name) from public.booking_resources br
                        join public.resources r on r.id = br.resource_id
                       where br.booking_id = b.id and br.addon_id is null), '{}') as resources,
            (select r.kind from public.booking_resources br join public.resources r on r.id = br.resource_id
              where br.booking_id = b.id and br.addon_id is null order by r.sort_order, r.name limit 1) as resource_kind,
            coalesce((select json_agg(json_build_object('name', ba.name, 'quantity', ba.quantity) order by ba.name)
                        from public.booking_addons ba where ba.booking_id = b.id), '[]'::json) as addons
       from public.bookings b
       join public.customers c on c.id = b.customer_id and c.line_user_id is not null
       join public.businesses biz on biz.id = b.business_id
       join public.offerings o on o.id = b.offering_id
       left join public.business_booking_settings s on s.business_id = b.business_id
       cross join (values ${KINDS.map((_, i) => `($${i * 3 + 3}::text, $${i * 3 + 4}::interval, $${i * 3 + 5}::interval)`).join(", ")}) k(kind, lead, stop)
      where b.status = 'confirmed'
        and coalesce(s.line_reminders, true)
        and $1::timestamptz >= b.start_at - k.lead and $1::timestamptz < b.start_at - k.stop
        and b.created_at <= b.start_at - k.lead
        and not exists (select 1 from public.booking_reminders r where r.booking_id = b.id and r.kind = k.kind)
      order by b.start_at
      limit $2`,
    [now.toISOString(), limit, ...KINDS.flatMap((k) => [k.kind, k.from, k.until])]
  );
  return rows;
}

/**
 * Sends what is due now. Returns { checked, sent, skipped } for the log.
 * push(to, messages) is injectable for tests; db is the server's pool (the database owner).
 */
async function sendDueReminders(db, { now = new Date(), push = (to, messages) => pushLine(db, to, messages), limit = 100, env = process.env } = {}) {
  const due = await dueReminders(db, now, limit);
  const origin = publicOrigin(env);
  let sent = 0;
  let skipped = 0;
  for (const r of due) {
    // claim it first: whoever inserts the row sends the card
    const claim = await db.query(
      "insert into public.booking_reminders (business_id, booking_id, kind) values ($1, $2, $3) on conflict do nothing returning booking_id",
      [r.business_id, r.id, r.kind]
    );
    if (!claim.rowCount) {
      skipped++;
      continue;
    }
    let result;
    try {
      const token = openLink(r.id, r.line_manage_token, env);
      const card = bookingCard({
        kind: KINDS.find((k) => k.kind === r.kind).card,
        shop: { name: r.shop_name, timezone: r.timezone },
        booking: {
          offering: r.offering,
          startAt: r.start_at,
          endAt: r.end_at,
          resources: r.resources,
          resourceKind: r.resource_kind,
          addons: r.addons,
          total: r.total ?? 0,
          deposit: null
        },
        link: token ? await manageLink(db, { slug: r.slug, token }, { env }) : null,
        directions: directionsLink({ address: r.address, mapUrl: r.map_url }),
        // no public address known (PUBLIC_ORIGIN / Railway's domain): the card goes without the QR
        checkin: origin ? { image: checkinImageUrl(origin, r.slug, r.id), code: bookingCode(r.id) } : null
      });
      result = await push(r.line_user_id, [card]);
    } catch (error) {
      console.error("[line-reminders] not sent:", error.message);
      result = { sent: false, reason: "ERROR" };
    }
    if (result?.sent) sent++;
    await db.query("update public.booking_reminders set result = $3 where booking_id = $1 and kind = $2", [
      r.id,
      r.kind,
      result?.sent ? "sent" : String(result?.reason ?? "ERROR").slice(0, 40)
    ]);
  }
  return { checked: due.length, sent, skipped };
}

// The server's own clock: every 5 minutes while it runs (one run at a time).
// The last tick is kept so /api/health can tell "nothing to send" from "the clock stopped".
let timer = null;
let lastRunAt = null;
let lastError = null;
function reminderLoopState() {
  return { started: timer !== null, lastRunAt, lastError };
}

function startReminderLoop(getDb, { everyMs = 5 * 60 * 1000 } = {}) {
  if (timer) return timer;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sent } = await sendDueReminders(getDb());
      if (sent) console.log(`[line-reminders] sent ${sent}`);
      // points set aside by bookings that ran out without a status change come back (migration …003200)
      await getDb().query("select public.loyalty_release_stale_holds()");
      // points that run out within 14 days (src/v2/loyalty-expiry.js), daytime only
      const points = await sendExpiryNotices(getDb());
      if (points.sent) console.log(`[loyalty-expiry] sent ${points.sent}`);
      lastError = null;
    } catch (error) {
      lastError = String(error.message).slice(0, 120);
      console.error("[line-reminders] run failed:", error.message);
    } finally {
      lastRunAt = new Date().toISOString();
      running = false;
    }
  };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  setTimeout(tick, 30 * 1000).unref?.(); // first run shortly after start
  return timer;
}

module.exports = { sendDueReminders, startReminderLoop, reminderLoopState };
