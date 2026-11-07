// "การจองของฉัน" (src/v2/my-bookings.js) against the test database: a LINE customer sees their own
// bookings at that shop (next first, past after), with their own link on the upcoming ones; nobody
// sees another person's or another shop's; no LINE proof, no list. LINE is stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");
const { myBookings, myWelcome } = require("../../src/v2/my-bookings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const BEE = "a1000000-0000-4000-8000-000000000002";
const ME = `U${"a".repeat(32)}`;
const SOMEONE = `U${"b".repeat(32)}`;
const env = { ...process.env, SETTINGS_ENCRYPTION_KEY: "m".repeat(40) };

let db;
test.before(async () => {
  if (skip) return;
  process.env.SETTINGS_ENCRYPTION_KEY = env.SETTINGS_ENCRYPTION_KEY; // book() seals the link with it
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
const LATER = bangkokTuesday(10);

async function inTx(fn) {
  await db.query("begin");
  try {
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

const as = (sub) => ({ verifyLineToken: async () => ({ sub, name: "ลูกค้า" }), notifyLine: async () => ({ sent: true }) });
const lineBook = (sub, date, time, resourceId = NAN) =>
  book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId, date, time }, customer: { name: "ลูกค้า LINE" }, lineIdToken: "t" }, as(sub));
const mine = (sub, opts = {}) => myBookings(db, "bloom-hair", { lineIdToken: "t" }, { ...as(sub), env, ...opts });

test("my bookings: the next one first with my own link, then the rest; past ones without a link", { skip }, async () => {
  await inTx(async () => {
    const later = await lineBook(ME, LATER, "11:00");
    const soon = await lineBook(ME, DAY, "10:00");
    const gone = await lineBook(ME, DAY, "14:00", BEE);
    await manage.cancelManaged(db, "bloom-hair", gone.manageToken, {});
    await lineBook(SOMEONE, DAY, "12:00"); // someone else's
    await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: BEE, date: DAY, time: "16:00" }, customer: { name: "เว็บ", phone: "0812345678" } }); // not from LINE

    const view = await mine(ME);
    assert.equal(view.shop.slug, "bloom-hair");
    assert.deepEqual(view.upcoming.map((b) => [b.date, b.start, b.status]), [[DAY, "10:00", "confirmed"], [LATER, "11:00", "confirmed"]]);
    assert.equal(view.upcoming[0].link, `/b/bloom-hair/manage/${soon.manageToken}`);
    assert.equal(view.upcoming[1].link, `/b/bloom-hair/manage/${later.manageToken}`);
    assert.equal(view.upcoming[0].offering.length > 0, true);
    assert.deepEqual(view.upcoming[0].resources.map((r) => r.kind), ["staff"]);
    assert.deepEqual(view.past.map((b) => [b.start, b.status, b.link]), [["14:00", "cancelled", null]]);

    // after the visit it moves to the past
    const after = await mine(ME, { now: new Date(Date.parse(`${LATER}T23:00:00+07:00`)) });
    assert.equal(after.upcoming.length, 0);
    assert.deepEqual(after.past.map((b) => b.start), ["11:00", "14:00", "10:00"]);
  });
});

test("nobody else's: another LINE user sees only theirs, another shop shows nothing, no LINE proof = refused", { skip }, async () => {
  await inTx(async () => {
    await lineBook(ME, DAY, "10:00");
    assert.deepEqual((await mine(SOMEONE)).upcoming, []);
    assert.deepEqual((await myBookings(db, "gentleman-barber", { lineIdToken: "t" }, { ...as(ME), env })).upcoming, []);
    await assert.rejects(myBookings(db, "bloom-hair", {}, { ...as(ME), env }), (e) => e.status === 403);
    await assert.rejects(myBookings(db, "bloom-hair", { lineIdToken: "bad" }, { verifyLineToken: async () => null, env }), (e) => e.status === 403);
    await assert.rejects(myBookings(db, "no-such-shop", { lineIdToken: "t" }, { ...as(ME), env }), (e) => e.status === 404);
  });
});

test("a booking from before links were kept shows no button; a hold that ran out shows as expired", { skip }, async () => {
  await inTx(async () => {
    const old = await lineBook(ME, DAY, "10:00");
    await db.query("update public.bookings set line_manage_token = null where id = $1", [old.id]);
    const view = await mine(ME);
    assert.equal(view.upcoming[0].link, null);

    await db.query("update public.bookings set status = 'held', hold_expires_at = now() - interval '1 minute' where id = $1", [old.id]);
    const expired = await mine(ME);
    assert.deepEqual([expired.upcoming.length, expired.past[0].status], [0, "expired"]);
  });
});

const welcome = (sub, slug = "bloom-hair") => myWelcome(db, slug, { lineIdToken: "t" }, { ...as(sub), env });

test("the booking page's welcome: name and phone from my last booking, my next booking with its link, visits; a first-timer gets nothing filled", { skip }, async () => {
  await inTx(async () => {
    assert.deepEqual(await welcome(ME), { customer: null, points: null, next: null }, "never booked here");

    const later = await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: LATER, time: "11:00" }, customer: { name: "มาลี ใจดี", phone: "0899998888" }, lineIdToken: "t" }, as(ME));
    const soon = await lineBook(ME, DAY, "10:00");
    await db.query("update public.bookings set status = 'completed', created_at = now() - interval '1 day' where id = $1", [later.id]); // a visit done (status only, for the count)
    await lineBook(SOMEONE, DAY, "12:00", BEE);

    const w = await welcome(ME);
    assert.equal(w.customer.name, "ลูกค้า LINE", "the name from the latest booking");
    assert.equal(w.customer.phone, "0899998888", "the phone kept on the customer");
    assert.equal(w.customer.visits, 1);
    assert.deepEqual([w.next.date, w.next.start, w.next.status, w.next.link], [DAY, "10:00", "confirmed", `/b/bloom-hair/manage/${soon.manageToken}`]);
    assert.equal(w.points, null, "no points programme");

    // someone else sees their own; another shop knows nobody; no LINE proof = refused
    assert.equal((await welcome(SOMEONE)).next.start, "12:00");
    assert.deepEqual(await welcome(ME, "gentleman-barber"), { customer: null, points: null, next: null });
    await assert.rejects(() => myWelcome(db, "bloom-hair", {}, as(ME)), (e) => e.status === 403);
    await assert.rejects(() => myWelcome(db, "bloom-hair", { lineIdToken: "t" }, { verifyLineToken: async () => null }), (e) => e.status === 403);
  });
});
