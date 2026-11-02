// What changed in the shop's bookings (docs/SALES_READINESS_ROADMAP.md Phase 0): new bookings, moves
// and cancellations, newest first, with what the signed-in member has not seen yet. The rows come from
// booking_events (migration …001800), written by a trigger on every change.
//
// Members (staff too) read it; the unread count is only what customers did, since the shop knows
// what it did itself.

const { msToLocal } = require("./options-engine");

const local = (at, timezone) => (at ? msToLocal(new Date(at).getTime(), timezone) : null);

/** { events: [...], unread } — `limit` newest events (default 30, at most 100) */
async function listActivity(client, shop, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
  const { rows } = await client.query(
    `select e.id, e.kind, e.actor, e.status, e.from_start, e.to_start, e.reason, e.created_at, e.booking_id,
            b.start_at, coalesce(b.customer_name, c.name) as customer_name, o.name as offering_name,
            e.actor = 'customer' and e.created_at > m.activity_seen_at as unread
       from public.booking_events e
       join public.bookings b on b.id = e.booking_id
       join public.offerings o on o.id = b.offering_id
       join public.customers c on c.id = b.customer_id
       left join public.business_members m on m.business_id = e.business_id and m.user_id = auth.uid()
      where e.business_id = $1 and (e.kind <> 'status' or e.actor <> 'shop')
      order by e.created_at desc, e.id desc
      limit $2`,
    [shop.id, limit]
  );
  const unread = await client.query(
    `select count(*)::int as n from public.booking_events e
       join public.business_members m on m.business_id = e.business_id and m.user_id = auth.uid()
      where e.business_id = $1 and e.actor = 'customer' and e.created_at > m.activity_seen_at`,
    [shop.id]
  );
  return {
    unread: unread.rows[0]?.n ?? 0,
    events: rows.map((e) => {
      const at = local(e.created_at, shop.timezone);
      const start = local(e.to_start ?? e.start_at, shop.timezone);
      const from = local(e.from_start, shop.timezone);
      return {
        id: String(e.id),
        bookingId: e.booking_id,
        kind: e.kind,
        actor: e.actor,
        status: e.status,
        unread: Boolean(e.unread),
        customerName: e.customer_name,
        offering: e.offering_name,
        date: start.date,
        time: start.time,
        from: from ? { date: from.date, time: from.time } : null,
        reason: e.reason,
        at: { date: at.date, time: at.time }
      };
    })
  };
}

/** The member has looked: newer customer events become unread from now on */
async function markActivitySeen(client, shop) {
  const { rows } = await client.query("select public.mark_activity_seen($1) as at", [shop.id]);
  return { seenAt: rows[0].at };
}

module.exports = { listActivity, markActivitySeen };
