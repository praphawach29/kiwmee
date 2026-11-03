// The check-in QR (src/v2/scan-codes.js) against the test database: the desk finds the booking by its
// id or by the 8-character code under the QR, the customer's pages carry it, and another shop's
// staff scanning the same QR find nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const { book } = require("../../src/v2/public-booking");
const { myBookings } = require("../../src/v2/my-bookings");
const { parseScan, scanUrl, bookingCode } = require("../../src/v2/scan-codes");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";
const SALON = "b1000000-0000-4000-8000-000000000001";
const BARBER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const DESK = { id: "ee200000-0000-4000-8000-000000000001" };
const RIVAL = { id: "ee200000-0000-4000-8000-000000000002" };
const MALI = `U${"3".repeat(32)}`;

let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function as(user, slug) {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, slug);
}

test("check-in QR: the desk finds the booking by link or code; another shop finds nothing", { skip }, async () => {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2)", [DESK.id, RIVAL.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'staff'), ($2, $4, 'owner')", [SALON, BARBER, DESK.id, RIVAL.id]);
    const line = { verifyLineToken: async () => ({ sub: MALI }), notifyLine: async () => ({ sent: true }) };
    await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: bangkokTuesday(3), time: "11:00" }, customer: { name: "มาลี" }, lineIdToken: "t" }, line);

    // the customer's page carries the booking's id for the QR
    const mine = await myBookings(db, "bloom-hair", { lineIdToken: "t" }, line);
    const id = mine.upcoming[0].checkin;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(mine.past.every((b) => b.checkin === null), true);

    const shop = await as(DESK, "bloom-hair");
    const scanned = parseScan(scanUrl("https://kiwmee.test", "bloom-hair", "b", id));
    const found = await bookings.findBooking(db, shop, scanned.ref);
    assert.equal(found.id, id);
    assert.equal(found.customer.name, "มาลี");
    const typed = await bookings.findBooking(db, shop, parseScan(bookingCode(id)).ref);
    assert.equal(typed.id, id);
    await db.query("savepoint bad");
    await assert.rejects(() => bookings.findBooking(db, shop, "nope"), /รหัสการจองไม่ถูกต้อง/);
    await db.query("rollback to savepoint bad");

    // a rival shop's staff scanning the same QR: nothing (RLS and the shop filter)
    const rival = await as(RIVAL, "gentleman-barber");
    assert.equal(await bookings.findBooking(db, rival, id), null);
    assert.equal(await bookings.findBooking(db, rival, bookingCode(id).toLowerCase()), null);
    const { rows } = await db.query("select count(*)::int as n from public.bookings where id = $1", [id]);
    assert.equal(rows[0].n, 0, "RLS hides the booking from another shop's member");
  } finally {
    await db.query("rollback");
  }
});
