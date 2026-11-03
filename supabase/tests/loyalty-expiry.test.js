// "Points run out soon" LINE cards (migration …003100) on top of points (migration …002800) against the test database: earned when a bill is paid,
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
const OWNER = { id: "ee310000-0000-4000-8000-000000000001" };
const DESK = { id: "ee310000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ee310000-0000-4000-8000-000000000003" };
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

const { sendExpiryNotices } = require("../../src/v2/loyalty-expiry");
const { clearCache } = require("../../src/v2/platform-settings");

// noon in Bangkok today: the cards go out in the daytime
const NOON = (() => { const d = new Date(); d.setUTCHours(5, 0, 0, 0); return d; })();
const days = (n) => new Date(NOON.getTime() + n * 86400000).toISOString();
const env = { ...process.env, PUBLIC_ORIGIN: "https://kiwmee.test", RAILWAY_PUBLIC_DOMAIN: "" };

async function lot(sub, points, expiresAt, kind = "adjust") {
  await db.query("reset role");
  await db.query(
    // clock_timestamp: one transaction, so now() would give every entry the same time and leave their order to chance
    "insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, expires_at, created_at) select brand_id, $2, id, $3, $4, $5, clock_timestamp() from public.businesses where id = $1",
    [SALON, sub, kind, points, expiresAt]
  );
}
async function run(now = NOON) {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
  clearCache();
  const sent = [];
  const result = await sendExpiryNotices(db, { now, env, push: async (to, messages) => (sent.push({ to, card: messages[0] }), { sent: true }) });
  return { ...result, sent };
}
const texts = (node) => (node && typeof node === "object" ? [node.text, node.action?.uri, node.altText, ...Object.values(node).flatMap(texts)].filter((t) => typeof t === "string") : []);

test("14 days before points run out: one card with how many, the day, the balance and what they buy", { skip }, async () => {
  await inTx(async () => {
    await lot(MALI, 100, days(10));
    await lot(MALI, 50, days(60));
    await lot(MALI, -30, null, "redeem"); // used from the soonest lot first: 70 of the 100 are left
    await lot(OTHER, 40, days(30)); // not yet: more than 14 days away

    assert.equal((await run(new Date(NOON.getTime() + 11 * 3600000))).checked, 0, "23:00 in Bangkok: not now");
    const first = await run();
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0].to, MALI);
    const all = texts(first.sent[0].card);
    assert.ok(all.some((t) => t.startsWith("70 คะแนนที่ Bloom")), `the alt text: ${first.sent[0].card.altText}`);
    for (const t of ["⏳ คะแนนใกล้หมดอายุ", "70 คะแนน", "120 คะแนน", "🎁 ส่วนลด 50 บาท", "https://kiwmee.test/b/bloom-hair/me", "https://kiwmee.test/b/bloom-hair"]) {
      assert.ok(all.includes(t), t);
    }
    assert.equal((await run()).sent.length, 0, "never twice for the same day");
    const { rows } = await db.query("select points, result from public.loyalty_expiry_notices where line_user_id = $1", [MALI]);
    assert.deepEqual(rows, [{ points: 70, result: "sent" }]);

    // another member who already used them all: recorded, no card
    await lot(OTHER, 20, days(5));
    await lot(OTHER, -60, null, "redeem");
    const used = await run();
    assert.equal(used.sent.length, 0);
    assert.equal((await db.query("select result from public.loyalty_expiry_notices where line_user_id = $1", [OTHER])).rows[0].result, "NOTHING_LEFT");
  });
});

test("no programme, no card; the brand's shops see who was told, nobody else, and nobody writes", { skip }, async () => {
  await inTx(async () => {
    await lot(MALI, 100, days(3));
    await db.query("update public.loyalty_programs set active = false");
    assert.equal((await run()).checked, 0);
    await db.query("update public.loyalty_programs set active = true");
    assert.equal((await run()).sent.length, 1);

    await as(DESK);
    assert.equal((await db.query("select count(*)::int as n from public.loyalty_expiry_notices")).rows[0].n, 1);
    await refused(() => db.query("insert into public.loyalty_expiry_notices (brand_id, line_user_id, expires_on) select brand_id, $2, current_date from public.businesses where id = $1", [SALON, OTHER]), (e) => e.code === "42501");
    await as(RIVAL, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.loyalty_expiry_notices")).rows[0].n, 0);
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.loyalty_expiry_notices"), (e) => e.code === "42501");
    await db.query("reset role");
  });
});

test("points used in the same moment as others come in are taken from the soonest-expiring ones", { skip }, async () => {
  await inTx(async () => {
    // all three share now(): the order between them must not depend on chance
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
    for (const [points, expires, kind] of [[-30, null, "redeem"], [100, days(10), "adjust"], [50, days(60), "earn"]]) {
      await db.query(
        "insert into public.loyalty_ledger (brand_id, line_user_id, business_id, kind, points, expires_at) select brand_id, $2, id, $3, $4, $5 from public.businesses where id = $1",
        [SALON, MALI, kind, points, expires]
      );
    }
    const { rows: [b] } = await db.query("select balance, expiring from public.loyalty_balance((select brand_id from public.businesses where id = $1), $2, $3)", [SALON, MALI, NOON.toISOString()]);
    assert.deepEqual([b.balance, b.expiring], [120, 70]);
  });
});
