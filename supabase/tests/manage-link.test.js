// The shop sends a customer their booking link (src/v2/admin-bookings.js issueManageLink, migration
// …001900) against the test database, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const BARBER = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const DESK = { id: "e8100000-0000-4000-8000-00000000000a", email: "desk@link.test" };
const OTHER = { id: "e8100000-0000-4000-8000-00000000000b", email: "barber@link.test" };
const HASH = "a".repeat(64);

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

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [DESK.id, DESK.email, OTHER.id, OTHER.email]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'staff'), ($2, $4, 'owner')", [SALON, BARBER, DESK.id, OTHER.id]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

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

test("a booking the shop takes comes with the customer's link, and a new link replaces the old one", { skip }, async () => {
  await inTx(async () => {
    const shop = await asMember(DESK);
    const made = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00", customer: { name: "โทรมา", phone: "0812345678" } });
    assert.match(made.managePath, new RegExp(`^/b/bloom-hair/manage/${made.manageToken}$`));
    assert.equal((await bookings.listBookings(db, shop, { from: DAY })).find((b) => b.id === made.id).hasLink, true);

    await asCustomer();
    const seen = await manage.findManaged(db, "bloom-hair", made.manageToken);
    assert.equal(seen.booking.customerName, "โทรมา");

    const again = await bookings.issueManageLink(db, await asMember(DESK), made.id);
    assert.notEqual(again.manageToken, made.manageToken);
    await asCustomer();
    await assert.rejects(manage.findManaged(db, "bloom-hair", made.manageToken), (e) => e.status === 404, "the old link stops working");
    await manage.cancelManaged(db, "bloom-hair", again.manageToken, { reason: "ไม่ว่าง" });
  });
});

test("a customer who booked online keeps a link; the shop can send a new one until the visit", { skip }, async () => {
  await inTx(async () => {
    await asCustomer();
    const online = await book(db, "bloom-hair", {
      selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "13:00" },
      customer: { name: "จองเอง", phone: "0812345678" }
    });
    const shop = await asMember(DESK);
    const listed = await bookings.listBookings(db, shop, { from: DAY });
    assert.equal(listed.find((b) => b.id === online.id).hasLink, true);

    await bookings.setStatus(db, shop, online.id, { status: "checked_in" });
    await refused(() => bookings.issueManageLink(db, shop, online.id), (e) => e.status === 422 && e.details?.reason === "NOT_CHANGEABLE");
    // a visit recorded afterwards is already over: no link
    const past = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: "2026-01-06", time: "11:00", customer: { name: "ย้อนหลัง" } });
    assert.equal(past.manageToken, undefined);
  });
});

test("only the booking's own shop can issue a link; anon cannot call it at all", { skip }, async () => {
  await inTx(async () => {
    const shop = await asMember(DESK);
    const made = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "15:00", customer: { name: "ของร้าน A" } });

    const other = await asMember(OTHER, "gentleman-barber");
    await refused(() => bookings.issueManageLink(db, other, made.id), (e) => e.status === 404);
    await refused(() => db.query("select public.issue_manage_link($1, $2)", [made.id, HASH]), (e) => e.code === "BK404");
    await refused(() => db.query("select public.issue_manage_link($1, 'not-a-hash')", [made.id]), (e) => e.code === "22023");

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select public.issue_manage_link($1, $2)", [made.id, HASH]), (e) => e.code === "42501");
    await db.query("reset role");
    await asCustomer();
    await db.query("set local role authenticated");
    await refused(() => db.query("select public.issue_manage_link($1, $2)", [made.id, HASH]), (e) => e.code === "42501", "signed-out caller");
  });
});
