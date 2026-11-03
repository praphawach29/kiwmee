// The brand logo and the cards of several brands (migration …003500) on top of points (migration …002800) against the test database: earned when a bill is paid,
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
const OWNER = { id: "ee350000-0000-4000-8000-000000000001" };
const DESK = { id: "ee350000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee350000-0000-4000-8000-000000000003" };
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
const LOGO = "https://ezubgqeqdipwfnmorqkj.supabase.co/storage/v1/object/public/shop-media/x/logo.webp";

async function give(businessId, sub, n) {
  await db.query("reset role");
  await clear();
  await db.query("insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, created_at) select brand_id, $2, id, 'adjust', $3, clock_timestamp() from public.businesses where id = $1", [businessId, sub, n]);
}

test("the brand's logo: set by its owner, on the member's card and the LINE cards", { skip }, async () => {
  await inTx(async () => {
    let owner = await as(OWNER);
    const saved = await loyalty.saveLogo(db, owner, { logoUrl: LOGO });
    assert.equal(saved.brand.logoUrl, LOGO);
    await refused(() => loyalty.saveLogo(db, owner, { logoUrl: "javascript:alert(1)" }), (e) => e.status === 422);
    await refused(() => loyalty.saveLogo(db, owner, { logoUrl: "http://plain.example/logo.png" }), (e) => e.status === 422);
    const desk = await as(DESK);
    await refused(() => loyalty.saveLogo(db, desk, { logoUrl: null }), (e) => e.status === 403);
    await refused(() => db.query("update public.brands set logo_url = null"), (e) => e.code === "42501");

    await give(SALON, MALI, 50);
    const card = (await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI))).points;
    assert.equal(card.logoUrl, LOGO);
    const { tierUpCard, tierStanding } = loyalty;
    const tiers = [{ rank: 0, name: "A", minSpend: 0, minVisits: 0, earnMultiplier: 1, cardTheme: "classic", benefits: [] }];
    assert.ok(JSON.stringify(tierUpCard({ shopName: "B", programName: "P", standing: tierStanding(tiers, { rank: 0, spend: 0, visits: 0 }), link: null, logoUrl: LOGO })).includes(LOGO));

    owner = await as(OWNER);
    assert.equal((await loyalty.saveLogo(db, owner, { logoUrl: null })).brand.logoUrl, null);
  });
});

test("a member of two brands swipes through both cards, this shop's first; nobody else's cards show", { skip }, async () => {
  await inTx(async () => {
    await db.query("reset role");
    await db.query("insert into public.loyalty_programs (brand_id, active, name, earn_mode, earn_per_baht, earn_points) select brand_id, true, 'Gentleman Club', 'per_baht', 100, 1 from public.businesses where id = $1 on conflict (brand_id) do update set active = true, name = excluded.name", [BARBER]);
    await give(SALON, MALI, 80);
    await give(BARBER, MALI, 30);
    await give(BARBER, OTHER, 99);

    const here = await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI));
    assert.equal(here.points.balance, 80);
    assert.deepEqual(here.otherCards.map((c) => [c.slug, c.card.name, c.card.balance]), [["gentleman-barber", "Gentleman Club", 30]]);
    const there = await myBookings(db, "gentleman-barber", { lineIdToken: "t" }, asLine(MALI));
    assert.equal(there.points.balance, 30);
    assert.deepEqual(there.otherCards.map((c) => c.slug), ["bloom-hair"]);

    // a programme switched off: its card is gone
    await db.query("reset role");
    await db.query("update public.loyalty_programs set active = false where brand_id = (select brand_id from public.businesses where id = $1)", [BARBER]);
    assert.equal((await myBookings(db, "bloom-hair", { lineIdToken: "t" }, asLine(MALI))).otherCards.length, 0);
  });
});
