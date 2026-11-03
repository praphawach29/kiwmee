// Membership tiers (migration …003000) on top of points (migration …002800) against the test database: earned when a bill is paid,
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
const OWNER = { id: "ee300000-0000-4000-8000-000000000001" };
const DESK = { id: "ee300000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee300000-0000-4000-8000-000000000003" };
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


const clear = () => db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
async function points(sub = MALI) {
  await db.query("reset role");
  await clear();
  return (await db.query("select balance from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2)", [SALON, sub])).rows[0].balance;
}
const TIERS = {
  qualifyMonths: 12,
  tiers: [
    { name: "Member", cardTheme: "classic" },
    { name: "Silver", minSpend: 800, earnMultiplier: 1.5, cardTheme: "silver", benefits: ["ส่วนลดวันเกิด 10%"] },
    { name: "Gold", minSpend: 5000, minVisits: 3, earnMultiplier: 2, cardTheme: "gold", benefits: ["จองล่วงหน้าได้ก่อน", "เครื่องดื่มฟรี"] }
  ]
};

test("tiers: from what was paid or how often; the tier's bonus on the next bill; a LINE card on moving up", { skip }, async () => {
  await inTx(async () => {
    let owner = await as(OWNER);
    const saved = await loyalty.saveTiers(db, owner, TIERS);
    assert.deepEqual(saved.tiers.map((t) => [t.rank, t.name, t.minSpend, t.minVisits, t.earnMultiplier, t.cardTheme]), [
      [0, "Member", 0, 0, 1, "classic"], [1, "Silver", 800, 0, 1.5, "silver"], [2, "Gold", 5000, 3, 2, "gold"]
    ]);
    const gold = (await loyalty.saveReward(db, owner, null, { name: "ทรีตเมนต์ฟรี", pointsCost: 10, discountBaht: 100, minTierRank: 2 })).rewards.find((r) => r.minTierRank === 2);

    const sent = [];
    const push = async (to, messages) => (sent.push({ to, card: messages[0] }), { sent: true });
    const close = async (time) => {
      const made = await lineBooking(MALI, time);
      const desk = await as(DESK);
      const bill = await bills.checkoutBooking(db, desk, made.id, { payments: [{ method: "cash", amount: 450 }] });
      await db.query("reset role");
      await clear();
      return { bill, tierCard: await loyalty.notifyTierUp(db, bill.id, { push }) };
    };

    // 1st: 450 → Member, ×1 = 40 points, no card
    let r = await close("11:00");
    assert.equal(await points(), 40);
    assert.equal(r.tierCard.skipped, "SAME_TIER");
    // 2nd: 900 paid → Silver; this bill still earns at the Member rate; the card goes out
    r = await close("14:00");
    assert.equal(await points(), 80);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, MALI);
    assert.match(sent[0].card.altText, /ระดับ Silver/);
    assert.match(JSON.stringify(sent[0].card.contents), /ส่วนลดวันเกิด 10%.*อีก 4,100 บาท หรือ 1 ครั้ง ถึง Gold|ได้คะแนน ×1\.5/);

    // the member's page: Silver, the bonus, the way to Gold; the Gold-only reward is locked
    let card = await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI)).then((x) => x.points);
    assert.deepEqual([card.tier.name, card.tier.cardTheme, card.tier.earnMultiplier], ["Silver", "silver", 1.5]);
    assert.equal(card.tier.next.text, "อีก 4,100 บาท หรือ 1 ครั้ง ถึง Gold");
    assert.equal(card.tier.next.progress, 0.67);
    const locked = card.rewards.find((x) => x.name === "ทรีตเมนต์ฟรี");
    assert.deepEqual([locked.usable, locked.tierName], [false, "Gold"]);

    // at the counter: Silver can't use the Gold reward even with the points
    const third = await lineBooking(MALI, "16:00");
    let desk = await as(DESK);
    const counter = await loyalty.memberAtCounter(db, desk, { bookingId: third.id });
    assert.equal(counter.tier.name, "Silver");
    assert.equal(counter.rewards.find((x) => x.id === gold.id).usable, false);
    await refused(() => bills.checkoutBooking(db, desk, third.id, { rewardId: gold.id, payments: [{ method: "cash", amount: 350 }] }), (e) => e.code === "TIER_TOO_LOW");
    // 3rd visit → Gold by visits; this bill earns at Silver ×1.5 = 60
    desk = await as(DESK);
    const bill3 = await bills.checkoutBooking(db, desk, third.id, { payments: [{ method: "cash", amount: 450 }] });
    await db.query("reset role");
    await clear();
    await loyalty.notifyTierUp(db, bill3.id, { push });
    assert.equal(await points(), 140);
    assert.equal(sent.length, 2);
    assert.match(sent[1].card.altText, /ระดับ Gold/);
    card = (await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI))).points;
    assert.equal(card.tier.name, "Gold");
    assert.equal(card.tier.next, null, "the top tier");
    assert.equal(card.rewards.find((x) => x.name === "ทรีตเมนต์ฟรี").usable, true);

    // spending points never lowers the tier; a refund does
    owner = await as(OWNER);
    await bills.refundBill(db, owner, bill3.id, { amount: 450, method: "cash" });
    card = (await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI))).points;
    assert.equal(card.tier.name, "Silver", "a refunded bill does not count");
  });
});

test("tiers: owner only, checked, read by the brand's members only", { skip }, async () => {
  await inTx(async () => {
    let desk = await as(DESK);
    await refused(() => loyalty.saveTiers(db, desk, TIERS), (e) => e.status === 403);
    const owner = await as(OWNER);
    for (const [bad, message] of [
      [{ tiers: Array.from({ length: 6 }, (_, i) => ({ name: `T${i}`, minSpend: i * 100 })) }, /ไม่เกิน 5 ระดับ/],
      [{ tiers: [{ name: "A" }, { name: "B" }] }, /ยอดใช้จ่ายหรือจำนวนครั้ง/],
      [{ tiers: [{ name: "A" }, { name: "B", minSpend: 500 }, { name: "C", minSpend: 400 }] }, /มากกว่าระดับก่อนหน้า/],
      [{ tiers: [{ name: "A" }, { name: "A", minSpend: 1 }] }, /ซ้ำ/],
      [{ tiers: [{ name: "A" }, { name: "B", minSpend: 1, earnMultiplier: 9 }] }, /1–5/]
    ]) {
      await refused(() => loyalty.saveTiers(db, owner, bad), (e) => e.status === 422 && message.test(e.message));
    }
    await loyalty.saveTiers(db, owner, TIERS);
    desk = await as(DESK);
    assert.equal((await loyalty.getLoyalty(db, desk)).tiers.length, 3, "staff see the tiers");
    await as(RIVAL, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.loyalty_tiers")).rows[0].n, 0, "another brand sees none");
    await refused(() => db.query("insert into public.loyalty_tiers (brand_id, rank, name) select brand_id, 3, 'X' from public.businesses where id = $1", [SALON]), (e) => e.code === "42501");
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.loyalty_tiers"), (e) => e.code === "42501");
    await refused(() => db.query("select * from public.loyalty_tier(gen_random_uuid(), 'U' || repeat('1', 32))"), (e) => e.code === "42501");
    await db.query("reset role");
    // [] = no tiers again
    await as(OWNER);
    assert.equal((await loyalty.saveTiers(db, await admin.memberShop(db, "bloom-hair"), { qualifyMonths: 6, tiers: [] })).tiers.length, 0);
  });
});
