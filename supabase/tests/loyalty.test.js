// Points for LINE members (migration …002800) against the test database: earned when a bill is paid,
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
const OWNER = { id: "ee100000-0000-4000-8000-000000000001" };
const DESK = { id: "ee100000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee100000-0000-4000-8000-000000000003" };
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

const balance = async (sub = MALI) => {
  await db.query("reset role");
  return (await db.query("select balance from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2)", [SALON, sub])).rows[0].balance;
};

test("paid bill earns from what was paid (rounded down); a reward takes points and gives the discount", { skip }, async () => {
  await inTx(async ({ reward }) => {
    const first = await lineBooking(MALI, "11:00");
    let desk = await as(DESK);
    const counter = await loyalty.memberAtCounter(db, desk, { bookingId: first.id });
    assert.deepEqual([counter.balance, counter.rewards[0].usable], [0, false]);
    await bills.checkoutBooking(db, desk, first.id, { payments: [{ method: "cash", amount: 450 }] });
    assert.equal(await balance(), 40, "450 baht → 4 × 10");

    // closing twice cannot earn twice; a booking from the web (no LINE) earns nothing
    const second = await lineBooking(MALI, "14:00");
    desk = await as(DESK);
    await refused(() => bills.checkoutBooking(db, desk, second.id, { rewardId: reward.id, payments: [{ method: "cash", amount: 450 }] }), (e) => e.status === 422, "450 − 50 = 400 must be paid");
    const closed = await bills.checkoutBooking(db, desk, second.id, { rewardId: reward.id, payments: [{ method: "transfer", amount: 400 }] });
    assert.equal(Number(closed.total), 400);
    assert.equal(await balance(), 40 - 30 + 40, "paid 400 → 40 points");

    desk = await as(DESK);
    const third = await lineBooking(MALI, "16:00");
    desk = await as(DESK);
    await bills.checkoutBooking(db, desk, third.id, { rewardId: reward.id, payments: [{ method: "cash", amount: 400 }] });
    assert.equal(await balance(), 50 - 30 + 40);
    const owner = await as(OWNER);
    const big = (await loyalty.saveReward(db, owner, null, { name: "ตัดฟรี", pointsCost: 500, discountBaht: 450 })).rewards.find((r) => r.pointsCost === 500);
    const fourth = await lineBooking(MALI, "18:00");
    desk = await as(DESK);
    await refused(() => bills.checkoutBooking(db, desk, fourth.id, { rewardId: big.id, payments: [{ method: "cash", amount: 0.01 }] }), (e) => e.status === 422 && e.code === "NOT_ENOUGH_POINTS");
  });
});

test("a refund takes points back in proportion; a voided bill gives its reward's points back", { skip }, async () => {
  await inTx(async ({ reward }) => {
    const made = await lineBooking(MALI, "11:00");
    const owner = await as(OWNER);
    const bill = await bills.checkoutBooking(db, owner, made.id, { payments: [{ method: "cash", amount: 450 }] });
    assert.equal(await balance(), 40);
    await as(OWNER);
    await bills.refundBill(db, owner, bill.id, { amount: 225, method: "cash" });
    assert.equal(await balance(), 20, "half refunded → half the points back");
    await as(OWNER);
    await bills.refundBill(db, owner, bill.id, { amount: 225, method: "cash" });
    assert.equal(await balance(), 0);

    // points used on a bill that is then voided come back
    await db.query("reset role");
    await db.query("insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points) select brand_id, $2, id, 'adjust', 100 from public.businesses where id = $1", [SALON, MALI]);
    const next = await lineBooking(MALI, "14:00");
    await as(OWNER);
    const open = (await db.query("select public.open_bill($1, $2) as id", [SALON, next.id])).rows[0].id;
    await db.query("select public.bill_use_reward($1, $2)", [open, reward.id]);
    assert.equal(await balance(), 70);
    await as(OWNER);
    await db.query("select public.void_bill($1, 'ผิด')", [open]);
    assert.equal(await balance(), 100);
  });
});

test("the oldest points are used first and points past their date are gone", { skip }, async () => {
  await inTx(async () => {
    const add = (points, kind, created, expires) =>
      db.query(
        "insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, created_at, expires_at) select brand_id, $2, id, $3, $4, $5, $6 from public.businesses where id = $1",
        [SALON, MALI, kind, points, created, expires]
      );
    await db.query("reset role");
    const d = (days) => new Date(Date.now() + days * 86400000).toISOString();
    await add(50, "earn", d(-400), d(-35)); // expired a month ago
    await add(30, "earn", d(-100), d(20)); // runs out in 20 days
    await add(40, "earn", d(-10), d(355));
    await add(-60, "redeem", d(-50), null); // spent while the first lot was still good: takes 50 from it, 10 from the next
    const { rows: [b] } = await db.query("select * from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2)", [SALON, MALI]);
    assert.deepEqual([b.balance, b.expiring], [20 + 40, 20], "first lot used up before it expired; 20 of the 2nd left, running out soon");
    const later = await db.query("select balance from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2, $3)", [SALON, MALI, d(30)]);
    assert.equal(later.rows[0].balance, 40, "a month on, the 2nd lot has run out");
  });
});

test("a walk-in member shows their code: the sale is tied to them and earns; a code is used once", { skip }, async () => {
  await inTx(async () => {
    await db.query("reset role");
    const { code } = await myMemberCode(db, "bloom-hair", { lineIdToken: "t" }, asLine(OTHER));
    assert.match(code, /^[0-9]{6}$/);
    const desk = await as(DESK);
    const peek = await loyalty.memberAtCounter(db, desk, { code });
    assert.equal(peek.balance, 0);
    await bills.createSale(db, desk, { title: "แชมพู", amount: 290, memberCode: code, payments: [{ method: "cash", amount: 290 }] });
    assert.equal(await balance(OTHER), 20);
    await as(DESK);
    await refused(() => bills.createSale(db, desk, { title: "อีกชิ้น", amount: 100, memberCode: code, payments: [{ method: "cash", amount: 100 }] }), (e) => e.status === 422 && e.code === "MEMBER_CODE_INVALID");
    // another brand cannot use this brand's code
    await db.query("reset role");
    const again = await myMemberCode(db, "bloom-hair", { lineIdToken: "t" }, asLine(OTHER));
    const rival = await as(RIVAL, "gentleman-barber");
    await refused(() => loyalty.memberAtCounter(db, rival, { code: again.code }), (e) => e.status === 422);

    // the member's own page shows the points (the server's connection: nobody signed in)
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
    const mine = await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(OTHER));
    assert.deepEqual([mine.points.balance, mine.points.rule], [20, "ทุก 100 บาท ได้ 10 คะแนน"]);
    assert.equal(mine.points.history[0].kind, "earn");
  });
});

test("no programme, no points; only the brand owner sets the rules; nobody writes points directly", { skip }, async () => {
  await inTx(async () => {
    const made = await lineBooking(MALI, "11:00");
    const desk = await as(DESK);
    await bills.checkoutBooking(db, desk, made.id, { payments: [{ method: "cash", amount: 450 }] });
    assert.equal(await balance(), 0, "programme not switched on");
    await as(DESK);
    await refused(() => loyalty.saveProgram(db, desk, { active: true, earnMode: "per_visit", earnPoints: 1 }), (e) => e.status === 403);
    await refused(() => loyalty.saveReward(db, desk, null, { name: "x", pointsCost: 1, discountBaht: 1 }), (e) => e.status === 403);
    await refused(() => db.query("insert into public.loyalty_ledger (brand_id, line_user_id, kind, points) select brand_id, $2, 'adjust', 999 from public.businesses where id = $1", [SALON, MALI]), (e) => e.code === "42501");
    await refused(() => db.query("select public.loyalty_issue_code((select brand_id from public.businesses where id = $1), $2)", [SALON, MALI]), (e) => e.code === "42501");
    await refused(() => loyalty.adjustPoints(db, desk, { lineUserId: MALI, points: 10 }), (e) => e.status === 403);

    const rival = await as(RIVAL, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.loyalty_programs")).rows[0].n, 0, "another brand sees nothing");
    await refused(() => db.query("select * from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2)", [SALON, MALI]), (e) => e.code === "42501");
    assert.ok(rival);
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.loyalty_ledger"), (e) => e.code === "42501");
  }, { programme: false });
});
