// The shop's bookings page (src/v2/admin-bookings.js) against the test database, as a signed-in
// member exactly as app/api/dashboard/shops/[slug]/bookings* does, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SHOP_A = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const SHOP_B = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001"; // 60 min + 10 buffer, 450
const NAN = "a1000000-0000-4000-8000-000000000001";
const BEE = "a1000000-0000-4000-8000-000000000002";

const USERS = {
  staffA: { id: "e4000000-0000-4000-8000-00000000000b", email: "desk-a@test.local" },
  ownerB: { id: "e4000000-0000-4000-8000-00000000000c", email: "owner-b2@test.local" }
};

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

// A Tuesday a few days ahead (ช่างบี is off on Wednesdays)
function bangkokTuesday() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokTuesday();

// A Tuesday 1–7 days ago
function pastTuesday() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const PAST = pastTuesday();

async function as(user, fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'staff'), ($2, $4, 'owner')", [
      SHOP_A,
      SHOP_B,
      USERS.staffA.id,
      USERS.ownerB.id
    ]);
    await admin.actAs(db, user);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("the front desk takes a phone booking at any minute and sees it on the day's list", { skip }, async () => {
  await as(USERS.staffA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair");
    const { id } = await bookings.createBooking(db, shop, {
      offeringId: CUT,
      resourceId: NAN,
      date: DAY,
      time: "10:05",
      customer: { name: "คุณโทรมา", phone: "089-111-2222" },
      notes: "ขอสระก่อน"
    });
    const list = await bookings.listBookings(db, shop, { from: DAY });
    assert.equal(list.length, 1);
    const b = list[0];
    assert.equal(b.id, id);
    assert.deepEqual([b.date, b.start, b.end, b.status, b.source, b.price, b.notes], [DAY, "10:05", "11:05", "confirmed", "admin", 450, "ขอสระก่อน"]);
    assert.deepEqual(b.customer, { name: "คุณโทรมา", phone: "0891112222", fromLine: false });
    assert.deepEqual(b.resources.map((r) => r.name), ["ช่างแนน"]);

    // the same stylist at an overlapping time is refused in words
    await refused(
      () => bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "10:30", customer: { name: "อีกคน" } }),
      (e) => e.status === 409 && e.message === "ช่วงเวลานี้มีการจองแล้ว"
    );
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, date: DAY, time: "10:30", customer: { name: " " } }), (e) => e.status === 422);
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, date: DAY, time: "21:00", customer: { name: "ดึก" } }), (e) => e.status === 422 && /นอกเวลาทำการ/.test(e.message));

    // free times for the form leave out ช่างแนน's booked hour
    const free = await bookings.freeTimes(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY });
    assert.ok(!free.times.includes("10:00") && !free.times.includes("10:30"));
    assert.ok(free.times.includes("11:15"));
  });
});

test("move, mark arrival and finish, and cancel", { skip }, async () => {
  await as(USERS.staffA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair");
    const { id } = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "10:00", customer: { name: "คุณย้าย" } });

    await bookings.rescheduleBooking(db, shop, id, { date: DAY, time: "13:00", resourceId: BEE });
    let [b] = await bookings.listBookings(db, shop, { from: DAY });
    assert.deepEqual([b.start, b.resources.map((r) => r.name)], ["13:00", ["ช่างบี"]]);

    await bookings.setStatus(db, shop, id, { status: "checked_in" });
    await bookings.setStatus(db, shop, id, { status: "completed" });
    await bookings.setStatus(db, shop, id, { status: "checked_in" });
    [b] = await bookings.listBookings(db, shop, { from: DAY });
    assert.equal(b.status, "checked_in", "undo a finish by mistake");
    await refused(() => bookings.setStatus(db, shop, id, { status: "no_show" }), (e) => e.status === 422);
    await refused(() => bookings.setStatus(db, shop, id, { status: "cancelled" }), (e) => e.status === 400);

    const second = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "15:00", customer: { name: "คุณยกเลิก" } });
    await bookings.cancelBooking(db, shop, second.id, { reason: "ลูกค้าโทรมายกเลิก" });
    const cancelled = (await bookings.listBookings(db, shop, { from: DAY })).find((x) => x.id === second.id);
    assert.equal(cancelled.status, "cancelled");
    const history = (await db.query("select to_status, reason from public.booking_status_history where booking_id = $1 order by created_at", [second.id])).rows;
    assert.deepEqual(history.at(-1), { to_status: "cancelled", reason: "ลูกค้าโทรมายกเลิก" });
    // the slot is free again
    await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "15:00", customer: { name: "คนใหม่" } });

    const noShow = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "17:00", customer: { name: "คุณไม่มา" } });
    await bookings.setStatus(db, shop, noShow.id, { status: "no_show" });
    await refused(() => bookings.setStatus(db, shop, noShow.id, { status: "confirmed" }), (e) => e.status === 422);
  });
});

test("a visit is recorded afterwards: completed by default, no-shows hold no one, checks still apply", { skip }, async () => {
  await as(USERS.staffA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair");
    const done = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: PAST, time: "10:00", customer: { name: "ลืมบันทึก", phone: "0812223333" } });
    assert.equal(done.status, "completed");
    const missed = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: BEE, date: PAST, time: "10:00", customer: { name: "ไม่มา" }, status: "no_show" });
    assert.equal(missed.status, "no_show");

    const list = await bookings.listBookings(db, shop, { from: PAST });
    const row = list.find((b) => b.id === done.id);
    assert.deepEqual([row.start, row.end, row.status, row.source, row.price, row.statusReason], ["10:00", "11:00", "completed", "admin", 450, "บันทึกย้อนหลัง"]);
    const held = (await db.query("select active from public.booking_resources where booking_id = $1", [missed.id])).rows;
    assert.deepEqual(held, [{ active: false }], "a no-show does not hold ช่างบี");
    const history = (await db.query("select from_status, to_status, reason from public.booking_status_history where booking_id = $1", [done.id])).rows;
    assert.deepEqual(history, [{ from_status: null, to_status: "completed", reason: "บันทึกย้อนหลัง" }]);

    // ช่างแนน was busy then; the shop was closed at night; a future time is an ordinary booking
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: PAST, time: "10:30", customer: { name: "ซ้อน" } }), (e) => e.status === 409);
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, date: PAST, time: "21:00", customer: { name: "ดึก" } }), (e) => e.status === 422);
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, date: PAST, time: "12:00", customer: { name: "x" }, status: "cancelled" }), (e) => e.status === 400);
    const later = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "12:00", customer: { name: "ล่วงหน้า" }, status: "completed" });
    assert.equal(later.status, "confirmed", "status only applies to a time that has passed");

    // more than a year back is refused, and the RPC itself refuses a future time
    const longAgo = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    await refused(() => bookings.createBooking(db, shop, { offeringId: CUT, date: longAgo, time: "12:00", customer: { name: "เก่า" } }), (e) => e.status === 422 && e.details.reason === "OUTSIDE_BOOKING_WINDOW");
    await refused(
      () => db.query(`select public.record_past_booking($1, $2, now() + interval '1 day', '{"name":"x"}'::jsonb)`, [SHOP_A, CUT]),
      (e) => e.code === "BK422" && e.message === "NOT_IN_PAST"
    );
  });
});

test("another shop's owner sees none of it and cannot touch it", { skip }, async () => {
  let id;
  await db.query("begin");
  try {
    const { rows } = await db.query(
      `select public.create_booking($1, $2, ($3 || ' 11:00+07')::timestamptz, '{"name":"ลูกค้าร้าน A"}'::jsonb, $4, null, 1, false, 'admin') as b`,
      [SHOP_A, CUT, DAY, NAN]
    );
    id = rows[0].b.id;
    await db.query("insert into auth.users (id, email) values ($1, $2)", [USERS.ownerB.id, USERS.ownerB.email]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')", [SHOP_B, USERS.ownerB.id]);
    await admin.actAs(db, USERS.ownerB);
    const own = await admin.memberShop(db, "gentleman-barber");
    assert.deepEqual(await bookings.listBookings(db, own, { from: DAY }), []);
    await refused(() => bookings.cancelBooking(db, own, id, {}), (e) => e.status === 404);
    // even with shop A's id, RLS hides the rows and the RPC refuses a non-member
    const fake = { id: SHOP_A, timezone: "Asia/Bangkok" };
    assert.deepEqual(await bookings.listBookings(db, fake, { from: DAY }), []);
    await refused(() => db.query("select public.cancel_booking($1)", [id]), (e) => e.code === "42501");
    await refused(
      () => db.query(`select public.record_past_booking($1, $2, now() - interval '1 day', '{"name":"x"}'::jsonb)`, [SHOP_A, CUT]),
      (e) => e.code === "42501"
    );
  } finally {
    await db.query("rollback");
  }
});
