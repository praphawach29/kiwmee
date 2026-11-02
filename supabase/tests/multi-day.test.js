// Rentals over several days (migration …002600, docs/FLEXIBLE_BOOKING_DESIGN.md 11.7) against the
// test database: a 'days' offering is booked for whole 24-hour periods, priced per day, cannot be lent
// twice over any part of it, needs the shop open at pick-up and at return, and keeps its days when moved.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const { book } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";
const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair: open every day
const OWNER = { id: "ec000000-0000-4000-8000-000000000001" };

let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const TUE = bangkokTuesday(3);
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const HOURS = 3600 * 1000;

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1)", [OWNER.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')", [SALON, OWNER.id]);
    await admin.actAs(db, OWNER);
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const car = await admin.saveResource(db, shop, null, { kind: "รถ", name: "Yaris กข 1234", capacity: 1 });
    const hire = await admin.saveOffering(db, shop, null, {
      name: "เช่ารถรายวัน", durationMode: "days", minDays: 1, maxDays: 3,
      requirements: [{ kind: "รถ", customerPicks: true, unitsPerBooking: "one" }], resourceIds: [car.id],
      prices: [{ unit: "per_day", amount: 1000, daysOfWeek: null, start: null, end: null, priority: null }]
    });
    await db.query("reset role");
    return await fn({ shop, car: car.id, hire: hire.id });
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

const rent = (ctx, date, time, days, extra = {}) =>
  book(db, "bloom-hair", { selected: { offeringId: ctx.hire, resourceId: ctx.car, date, time, durationMinutes: days * 1440 }, customer: { name: "ผู้เช่า", phone: "0812345678" }, ...extra });

test("2 days from Tuesday 11:00: back Thursday 11:00, priced 2 × per day; the car cannot go out again in between", { skip }, async () => {
  await inTx(async (ctx) => {
    const made = await rent(ctx, TUE, "11:00", 2);
    assert.equal(new Date(made.endAt) - new Date(made.startAt), 48 * HOURS);
    assert.equal(Number(made.price.total), 2000);
    assert.equal(made.price.unit, "per_day");

    await refused(() => rent(ctx, addDays(TUE, 1), "11:00", 1), (e) => e.status === 409 && e.details.reason === "FULLY_BOOKED");
    await refused(() => rent(ctx, addDays(TUE, -1), "12:00", 1), (e) => e.status === 409, "Monday 12:00 → Tuesday 12:00 overlaps");
    // right after it comes back: fine
    const next = await rent(ctx, addDays(TUE, 2), "11:00", 1);
    assert.ok(next.id);
  });
});

test("whole days only, within the shop's min–max; the shop must be open at pick-up and at return", { skip }, async () => {
  await inTx(async (ctx) => {
    await refused(() => book(db, "bloom-hair", { selected: { offeringId: ctx.hire, resourceId: ctx.car, date: TUE, time: "11:00", durationMinutes: 90 }, customer: { name: "x", phone: "0812345678" } }), (e) => e.status === 422);
    await refused(() => rent(ctx, TUE, "11:00", 4), (e) => e.status === 422);

    // closed all of the return day: refused with its own reason; closed only in between: fine
    await db.query("insert into public.business_closures (business_id, date, is_full_day) values ($1, $2, true)", [SALON, addDays(TUE, 2)]);
    await refused(() => rent(ctx, TUE, "11:00", 2), (e) => e.status === 422 && e.details.reason === "RETURN_CLOSED");
    const across = await rent(ctx, addDays(TUE, 1), "11:00", 3); // Wed → Sat, the closed Thursday in the middle
    assert.ok(across.id);
  });
});

test("the shop moves a rental: it keeps its days; the owner sets the days mode in the service form", { skip }, async () => {
  await inTx(async (ctx) => {
    const made = await rent(ctx, TUE, "11:00", 2);
    await admin.actAs(db, OWNER);
    const moved = await bookings.rescheduleBooking(db, ctx.shop, made.id, { date: addDays(TUE, 7), time: "14:00" });
    assert.ok(moved.previous);
    const { rows: [b] } = await db.query("select start_at, end_at from public.bookings where id = $1", [made.id]);
    assert.equal(new Date(b.end_at) - new Date(b.start_at), 48 * HOURS);

    const catalog = await admin.getCatalog(db, ctx.shop);
    const o = catalog.offerings.find((x) => x.id === ctx.hire);
    assert.deepEqual([o.durationMode, o.minDays, o.maxDays, o.prices[0].unit], ["days", 1, 3, "per_day"]);
    await refused(() => admin.saveOffering(db, ctx.shop, ctx.hire, { name: "เช่า", durationMode: "days", minDays: 3, maxDays: 2 }), (e) => e.status === 422);
    await db.query("reset role");
    await refused(() => db.query("update public.offerings set min_days = null where id = $1", [ctx.hire]), (e) => e.code === "23514");
  });
});
