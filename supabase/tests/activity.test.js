// Booking activity (src/v2/admin-activity.js, migration …001800) against the test database: customers
// book, move and cancel through the public API and their link (no signed-in user), the shop works as a
// signed-in member, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const activity = require("../../src/v2/admin-activity");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const BARBER = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const DESK = { id: "e8000000-0000-4000-8000-00000000000a", email: "desk@activity.test" };
const OTHER = { id: "e8000000-0000-4000-8000-00000000000b", email: "barber@activity.test" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokTuesday(3);

// A front-desk member of the salon who last looked an hour ago, and the barber's owner
async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [DESK.id, DESK.email, OTHER.id, OTHER.email]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role, activity_seen_at) values ($1, $3, 'staff', now() - interval '1 hour'), ($2, $4, 'owner', now() - interval '1 hour')",
      [SALON, BARBER, DESK.id, OTHER.id]
    );
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

// The public API and the customer link run with no signed-in user
async function asCustomer() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
}

async function asMember(user, slug = "bloom-hair") {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, slug);
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("what customers do shows up for the shop, unread until a member looks", { skip }, async () => {
  await inTx(async () => {
    await asCustomer();
    const b = await book(db, "bloom-hair", {
      selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00" },
      customer: { name: "คุณแจ้ง", phone: "0812345678" }
    });
    await manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "13:00" });
    await manage.cancelManaged(db, "bloom-hair", b.manageToken, { reason: "ติดงาน" });

    const shop = await asMember(DESK);
    // the shop's own work is listed but not unread; its day-of-visit steps are left out
    const own = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "15:00", customer: { name: "โทรมา" } });
    await bookings.setStatus(db, shop, own.id, { status: "checked_in" });

    let feed = await activity.listActivity(db, shop);
    assert.equal(feed.unread, 3);
    assert.deepEqual(
      feed.events.map((e) => [e.kind, e.actor, e.customerName, e.unread]),
      [
        ["created", "shop", "โทรมา", false],
        ["cancelled", "customer", "คุณแจ้ง", true],
        ["rescheduled", "customer", "คุณแจ้ง", true],
        ["created", "customer", "คุณแจ้ง", true]
      ]
    );
    const moved = feed.events.find((e) => e.kind === "rescheduled");
    assert.deepEqual([moved.from, moved.date, moved.time, moved.offering], [{ date: DAY, time: "11:00" }, DAY, "13:00", "ตัดผมหญิง + สระไดร์"]);
    assert.equal(feed.events.find((e) => e.kind === "cancelled").reason, "ลูกค้ายกเลิกเอง: ติดงาน");

    await activity.markActivitySeen(db, shop);
    feed = await activity.listActivity(db, shop);
    assert.deepEqual([feed.unread, feed.events.filter((e) => e.unread).length], [0, 0]);
  });
});

test("a hold that runs out is the system's doing", { skip }, async () => {
  await inTx(async () => {
    await asCustomer();
    const { rows } = await db.query(
      `select public.create_booking($1, $2, ($3 || ' 11:00+07')::timestamptz, '{"name":"รอโอน","phone":"0899999999"}'::jsonb, $4, null, 1, true) as b`,
      [SALON, CUT, DAY, NAN]
    );
    await db.query("update public.bookings set hold_expires_at = now() - interval '1 second' where id = $1", [rows[0].b.id]);
    await db.query("select public.expire_holds($1)", [SALON]);

    const shop = await asMember(DESK);
    const feed = await activity.listActivity(db, shop);
    const expired = feed.events.find((e) => e.kind === "status");
    assert.deepEqual([expired.actor, expired.status, expired.unread], ["system", "expired", false]);
    assert.equal(feed.unread, 1, "only the customer's booking counts");
  });
});

test("another shop sees none of it; nobody writes activity by hand", { skip }, async () => {
  await inTx(async () => {
    await asCustomer();
    await book(db, "bloom-hair", {
      selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00" },
      customer: { name: "คุณลับ", phone: "0812345678" }
    });

    const other = await asMember(OTHER, "gentleman-barber");
    assert.deepEqual((await activity.listActivity(db, other)).events, []);
    assert.deepEqual((await activity.listActivity(db, { id: SALON, timezone: "Asia/Bangkok" })).events, [], "RLS hides the salon's rows");
    await refused(() => activity.markActivitySeen(db, { id: SALON }), (e) => e.code === "42501");
    const someBooking = (await db.query("select id from public.bookings limit 1")).rows[0];
    assert.equal(someBooking, undefined, "the barber's owner sees no salon booking either");

    await asMember(DESK);
    const bookingId = (await db.query("select id from public.bookings where customer_name = 'คุณลับ'")).rows[0].id;
    await refused(
      () => db.query("insert into public.booking_events (business_id, booking_id, kind, actor) values ($1, $2, 'created', 'customer')", [SALON, bookingId]),
      (e) => e.code === "42501"
    );

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.booking_events"), (e) => e.code === "42501");
    await refused(() => db.query(`select public.mark_activity_seen('${SALON}')`), (e) => e.code === "42501");
  });
});
