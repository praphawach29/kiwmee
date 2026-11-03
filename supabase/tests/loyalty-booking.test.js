// Points used when booking online (migration …003200) on top of points (migration …002800) against the test database: earned when a bill is paid,
// a reward takes points and gives a discount, a refund takes points back in proportion, the oldest
// points expire first, a walk-in member ties a sale with their code, and only the brand sees any of it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const bills = require("../../src/v2/admin-bills");
const loyalty = require("../../src/v2/loyalty");
const { book } = require("../../src/v2/public-booking");
const { myBookings, myMemberCode } = require("../../src/v2/my-bookings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";
const SALON = "b1000000-0000-4000-8000-000000000001";
const BARBER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001"; // 450
const NAN = "a1000000-0000-4000-8000-000000000001";
const OWNER = { id: "ee320000-0000-4000-8000-000000000001" };
const DESK = { id: "ee320000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee320000-0000-4000-8000-000000000003" };
const MALI = `U${"1".repeat(32)}`;
const OTHER = `U${"2".repeat(32)}`;

let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokTuesday(3);

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

const asLine = (sub) => ({ verifyLineToken: async () => ({ sub }), notifyLine: async () => ({ sent: true }) });
async function lineBooking(sub, time) {
  await db.query("reset role");
  return book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time }, customer: { name: "มาลี" }, lineIdToken: "t" }, asLine(sub));
}
async function as(user, slug = "bloom-hair") {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, slug);
}

// a salon with a points programme: every 100 baht = 10 points, 12 months; reward 30 points = 50 baht off
async function inTx(fn, { programme = true } = {}) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [OWNER.id, DESK.id, RIVAL.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')", [SALON, BARBER, OWNER.id, DESK.id, RIVAL.id]);
    await db.query("insert into public.brand_members (brand_id, user_id) select brand_id, $2 from public.businesses where id = $1", [SALON, OWNER.id]);
    await db.query("insert into public.brand_members (brand_id, user_id) select brand_id, $2 from public.businesses where id = $1", [BARBER, RIVAL.id]);
    let reward = null;
    if (programme) {
      const shop = await as(OWNER);
      await loyalty.saveProgram(db, shop, { active: true, earnMode: "per_baht", earnPerBaht: 100, earnPoints: 10, expireMonths: 12 });
      reward = (await loyalty.saveReward(db, shop, null, { name: "ส่วนลด 50 บาท", pointsCost: 30, discountBaht: 50 })).rewards[0];
    }
    return await fn({ reward });
  } finally {
    await db.query("rollback");
  }
}

const { findManaged, cancelManaged } = require("../../src/v2/manage-booking");

const clear = () => db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
async function points(sub = MALI) {
  await db.query("reset role");
  await clear();
  return (await db.query("select balance from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2)", [SALON, sub])).rows[0].balance;
}
async function give(sub, n) {
  await db.query("reset role");
  await clear();
  await db.query("insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, created_at) select brand_id, $2, id, 'adjust', $3, clock_timestamp() - interval '1 hour' from public.businesses where id = $1", [SALON, sub, n]);
}
const sent = [];
const lineFor = (sub) => ({ verifyLineToken: async () => ({ sub }), notifyLine: async (to, messages) => (sent.push(messages[0]), { sent: true }) });
async function bookWith(time, rewardId, sub = MALI) {
  await db.query("reset role");
  await clear();
  return book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time }, customer: { name: "มาลี" }, lineIdToken: "t", rewardId }, lineFor(sub));
}
const bookingCount = async () => (await db.query("select count(*)::int as n from public.bookings where business_id = $1", [SALON])).rows[0].n;

test("a reward chosen when booking: points set aside at once, the desk takes them off the bill", { skip }, async () => {
  await inTx(async ({ reward }) => {
    await give(MALI, 100);
    const made = await bookWith("11:00", reward.id);
    assert.deepEqual(made.points, { rewardId: reward.id, name: "ส่วนลด 50 บาท", points: 30, discountBaht: 50 });
    assert.equal(await points(), 70, "set aside at once");
    const card = JSON.stringify(sent.at(-1).contents);
    assert.ok(card.includes("ใช้คะแนน") && card.includes("ส่วนลด 50 บาท (30 คะแนน · ลด 50 บาท)"), "the LINE card says so");

    // the customer's pages and the shop's list show it
    assert.equal((await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI))).upcoming[0].points.name, "ส่วนลด 50 บาท");
    await db.query("reset role");
    const view = await findManaged(db, "bloom-hair", made.manageToken);
    assert.equal(view.points.discountBaht, 50);
    let desk = await as(DESK);
    const listed = (await bookings.listBookings(db, desk, { from: DAY })).find((b) => b.id === made.id);
    assert.deepEqual(listed.heldReward, { name: "ส่วนลด 50 บาท", points: 30 });
    const counter = await loyalty.memberAtCounter(db, desk, { bookingId: made.id });
    assert.equal(counter.held.rewardId, reward.id);
    assert.equal(counter.rewards.find((r) => r.id === reward.id).usable, true, "the held points count for it");

    // the desk closes without saying: the held reward is used — 450 − 50 = 400 → 40 points
    const bill = await bills.checkoutBooking(db, desk, made.id, { payments: [{ method: "cash", amount: 400 }] });
    assert.equal(Number(bill.total), 400);
    assert.equal(await points(), 70 + 40);
    const { rows } = await db.query("select kind, points from public.loyalty_ledger where booking_id = $1 or bill_id = $2 order by created_at, kind", [made.id, bill.id]);
    assert.deepEqual(rows.map((r) => `${r.kind}${r.points}`).sort(), ["earn40", "hold-30", "redeem-30", "release30"].sort());
  });
});

test("not enough points or the wrong tier: no booking at all; web bookings cannot use points", { skip }, async () => {
  await inTx(async ({ reward }) => {
    await give(MALI, 20);
    const before = await bookingCount();
    await refused(() => bookWith("11:00", reward.id), (e) => e.status === 422 && e.code === "NOT_ENOUGH_POINTS" && /ยังไม่ได้จอง/.test(e.message));
    assert.equal(await bookingCount(), before, "the booking rolled back with it");
    await refused(() => book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00" }, customer: { name: "เว็บ", phone: "0812345678" }, rewardId: reward.id }), (e) => e.status === 403);

    const owner = await as(OWNER);
    await loyalty.saveTiers(db, owner, { tiers: [{ name: "Member" }, { name: "Gold", minSpend: 100000 }] });
    const gold = (await loyalty.saveReward(db, owner, null, { name: "Gold เท่านั้น", pointsCost: 1, discountBaht: 10, minTierRank: 1 })).rewards.find((r) => r.minTierRank === 1);
    await refused(() => bookWith("11:00", gold.id), (e) => e.code === "TIER_TOO_LOW");
    assert.equal(await bookingCount(), before);
  });
});

test("called off, no-show, a hold that ran out, or the desk chose none: the points come back", { skip }, async () => {
  await inTx(async ({ reward }) => {
    await give(MALI, 100);
    // the customer cancels
    const a = await bookWith("10:00", reward.id);
    assert.equal(await points(), 70);
    await db.query("reset role");
    await cancelManaged(db, "bloom-hair", a.manageToken, { reason: "ไม่ว่าง" });
    assert.equal(await points(), 100, "cancelled");

    // a deposit hold that ran out without anyone changing the status: the server's sweep
    const b = await bookWith("12:00", reward.id);
    await db.query("update public.bookings set status = 'held', hold_expires_at = now() - interval '1 minute' where id = $1", [b.id]);
    assert.equal(await points(), 70);
    assert.equal((await db.query("select public.loyalty_release_stale_holds() as n")).rows[0].n, 1);
    assert.equal(await points(), 100, "ran out");
    assert.equal((await db.query("select public.loyalty_release_stale_holds() as n")).rows[0].n, 0, "once");

    // the desk chooses no reward: the points come back, the bill earns on the full price
    const c = await bookWith("14:00", reward.id);
    const desk = await as(DESK);
    await bills.checkoutBooking(db, desk, c.id, { rewardId: null, payments: [{ method: "cash", amount: 450 }] });
    assert.equal(await points(), 100 + 40);

    // no-show
    const d = await bookWith("16:00", reward.id);
    assert.equal(await points(), 110);
    await as(DESK);
    await db.query("reset role");
    await db.query("update public.bookings set status = 'no_show' where id = $1", [d.id]);
    assert.equal(await points(), 140);

    // nobody but the server sets points aside or gives them back
    await as(DESK);
    await refused(() => db.query("select public.loyalty_hold_for_booking($1, $2)", [d.id, reward.id]), (e) => e.code === "42501");
    await refused(() => db.query("select public.loyalty_release_hold($1)", [d.id]), (e) => e.code === "42501");
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.loyalty_booking_hold($1)", [d.id]), (e) => e.code === "42501");
    await db.query("reset role");
  });
});
