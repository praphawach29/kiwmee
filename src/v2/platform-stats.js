// สถิติภาพรวมแพลตฟอร์มสำหรับ /super dashboard
// — การจองวันนี้, ลูกค้าที่ผูก LINE, กิจกรรมล่าสุด
// อ่านข้ามทุกแบรนด์ ต้องเป็น platform admin เท่านั้น

const { ownerTx } = require("./wallet");
const { requirePlatformAdmin } = require("./platform-settings");

const TODAY_START = `(date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')`;
const TODAY_END = `(${TODAY_START} + '1 day'::interval)`;

const ACTIVE_STATUSES = `('confirmed','pending','checked_in','completed')`;

const KIND_LABEL = { created: "จองใหม่", rescheduled: "เลื่อนนัด", cancelled: "ยกเลิก", status: "เปลี่ยนสถานะ" };
const ACTOR_LABEL = { customer: "ลูกค้า", shop: "ร้าน", system: "ระบบ" };

async function platformStats() {
  return ownerTx(async (client) => {
    await requirePlatformAdmin(client);

    const { rows: [counts] } = await client.query(`
      select
        (select count(*)::int from public.bookings
          where start_at >= ${TODAY_START} and start_at < ${TODAY_END}
            and status in ${ACTIVE_STATUSES}) as bookings_today,
        (select count(*)::int from public.customers where line_user_id is not null) as line_customers,
        (select count(*)::int from public.wallet_topups where status = 'pending') as pending_topups
    `);

    const { rows: activity } = await client.query(`
      select e.id, e.kind, e.actor, e.created_at, e.status as booking_status,
             b.name as business_name, e.booking_id
        from public.booking_events e
        join public.businesses b on b.id = e.business_id
       order by e.created_at desc
       limit 15
    `);

    return {
      bookingsToday: counts?.bookings_today ?? 0,
      lineCustomers: counts?.line_customers ?? 0,
      pendingTopups: counts?.pending_topups ?? 0,
      activity: activity.map((e) => ({
        id: e.id,
        kind: e.kind,
        kindLabel: KIND_LABEL[e.kind] ?? e.kind,
        actor: e.actor,
        actorLabel: ACTOR_LABEL[e.actor] ?? e.actor,
        businessName: e.business_name,
        bookingId: e.booking_id,
        createdAt: e.created_at,
      })),
    };
  });
}

module.exports = { platformStats };
