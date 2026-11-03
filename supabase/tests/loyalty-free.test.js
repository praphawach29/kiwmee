// Free-service rewards (migration …003400) on top of points (migration …002800) against the test database: earned when a bill is paid,
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
const OWNER = { id: "ee340000-0000-4000-8000-000000000001" };
const DESK = { id: "ee340000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee340000-0000-4000-8000-000000000003" };
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

const { myRewards } = require("../../src/v2/my-bookings");
const COLOR = "c1000000-0000-4000-8000-000000000002"; // 1,500
const MENS = "c2000000-0000-4000-8000-000000000001"; // another brand's service

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
const lineFor = (sub) => ({ verifyLineToken: async () => ({ sub }), notifyLine: async () => ({ sent: true }) });
async function bookWith(time, rewardId, offeringId = CUT) {
  await db.query("reset role");
  await clear();
  return book(db, "bloom-hair", { selected: { offeringId, resourceId: offeringId === CUT ? NAN : undefined, date: DAY, time }, customer: { name: "มาลี" }, lineIdToken: "t", rewardId }, lineFor(MALI));
}
async function freeReward(offeringId, extra = {}) {
  const owner = await as(OWNER);
  const all = (await loyalty.saveReward(db, owner, null, { name: `ฟรี ${offeringId.slice(-1)}`, kind: "free_offering", offeringId, pointsCost: 100, ...extra })).rewards;
  return all.find((r) => r.kind === "free_offering" && r.offeringId === offeringId && r.discountBaht === (extra.discountBaht ?? null));
}

test("a free service: held when booking that service, worth its own price; the desk takes it off", { skip }, async () => {
  await inTx(async () => {
    await give(MALI, 300);
    const cut = await freeReward(CUT);
    assert.deepEqual([cut.kind, cut.offeringName, cut.discountBaht], ["free_offering", "ตัดผมหญิง + สระไดร์", null]);

    // the booking page: fits only the service being booked
    const list = await myRewards(db, "bloom-hair", { lineIdToken: "t", offeringId: COLOR }, lineFor(MALI));
    assert.deepEqual(list.rewards.filter((r) => r.id === cut.id).map((r) => [r.fits, r.usable]), [[false, false]]);
    const fits = await myRewards(db, "bloom-hair", { lineIdToken: "t", offeringId: CUT }, lineFor(MALI));
    assert.equal(fits.rewards.find((r) => r.id === cut.id).usable, true);

    const made = await bookWith("11:00", cut.id);
    assert.deepEqual([made.points.discountBaht, made.points.points], [450, 100]);
    assert.equal(await points(), 200);

    // at the desk: the customer added something (600); the free cut takes off 450
    let desk = await as(DESK);
    const counter = await loyalty.memberAtCounter(db, desk, { bookingId: made.id });
    assert.deepEqual(counter.rewards.filter((r) => r.id === cut.id).map((r) => [r.discountBaht, r.fits, r.usable]), [[450, true, true]]);
    const bill = await bills.checkoutBooking(db, desk, made.id, { subtotal: 600, payments: [{ method: "cash", amount: 150 }] });
    assert.deepEqual([Number(bill.discount), Number(bill.total)], [450, 150]);
  });
});

test("a free service does not fit another service: no booking, and the desk cannot use it either", { skip }, async () => {
  await inTx(async () => {
    await give(MALI, 300);
    const color = await freeReward(COLOR);
    await db.query("reset role");
    const before = (await db.query("select count(*)::int as n from public.bookings")).rows[0].n;
    await refused(() => bookWith("11:00", color.id), (e) => e.code === "REWARD_NOT_FOR_THIS" && /ยังไม่ได้จอง/.test(e.message));
    assert.equal((await db.query("select count(*)::int as n from public.bookings")).rows[0].n, before);

    const made = await bookWith("11:00", null);
    let desk = await as(DESK);
    const counter = await loyalty.memberAtCounter(db, desk, { bookingId: made.id });
    assert.deepEqual(counter.rewards.filter((r) => r.id === color.id).map((r) => [r.fits, r.usable]), [[false, false]]);
    await refused(() => bills.checkoutBooking(db, desk, made.id, { rewardId: color.id, payments: [{ method: "cash", amount: 450 }] }), (e) => e.code === "REWARD_NOT_FOR_THIS");
    assert.equal(await points(), 300, "no points moved");
  });
});

test("walk-in sales and a capped value; only the brand's own services", { skip }, async () => {
  await inTx(async () => {
    await give(MALI, 300);
    const capped = await freeReward(COLOR, { discountBaht: 1000 });
    // a walk-in with the member's code: the desk decides; worth the service's price, up to the cap and the sale
    await db.query("reset role");
    await clear();
    const { code } = await loyalty.issueMemberCode(db, { id: SALON }, MALI);
    const desk = await as(DESK);
    assert.equal((await loyalty.memberAtCounter(db, desk, { code })).rewards.find((r) => r.id === capped.id).discountBaht, 1000);
    const sale = await bills.createSale(db, desk, { title: "ทำสีผม", amount: 1500, memberCode: code, rewardId: capped.id, payments: [{ method: "cash", amount: 500 }] });
    assert.deepEqual([Number(sale.discount), Number(sale.total)], [1000, 500]);

    const owner = await as(OWNER);
    await refused(() => loyalty.saveReward(db, owner, null, { name: "ไม่มีบริการ", kind: "free_offering", pointsCost: 10 }), (e) => e.status === 422 && /เลือกบริการ/.test(e.message));
    await refused(() => loyalty.saveReward(db, owner, null, { name: "ร้านอื่น", kind: "free_offering", offeringId: MENS, pointsCost: 10 }), (e) => e.status === 422 && /ของแบรนด์นี้/.test(e.message));
  });
});
