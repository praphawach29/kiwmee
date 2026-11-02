// LINE appointment reminders (migration …002300, src/v2/line-reminders.js) against the test database:
// which bookings are due when, that a reminder goes once, that a moved booking is reminded again,
// and that the card carries the customer's own link. Sending is stubbed; the clock is passed in.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");
const { sendDueReminders } = require("../../src/v2/line-reminders");
const { clearCache } = require("../../src/v2/platform-settings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const LINE_USER = `U${"c".repeat(32)}`;
const env = { ...process.env, SETTINGS_ENCRYPTION_KEY: "k".repeat(40) };

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
const HOUR = 3600 * 1000;

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into public.platform_settings (key, value, is_secret) values ('line.liff_id', '2010969802-QiiDBSxa', false) on conflict (key) do update set value = excluded.value");
    clearCache();
    return await fn();
  } finally {
    await db.query("rollback");
    clearCache();
  }
}

const fromLine = { verifyLineToken: async () => ({ sub: LINE_USER, name: "ลูกค้า LINE" }), notifyLine: async () => ({ sent: true }) };
const lineBooking = (time) => book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time }, customer: { name: "ลูกค้า LINE" }, lineIdToken: "t" }, fromLine);
const texts = (node) => (node && typeof node === "object" ? [node.text, node.action?.uri, ...Object.values(node).flatMap(texts)].filter((t) => typeof t === "string") : []);

async function run(at) {
  const sent = [];
  const result = await sendDueReminders(db, { now: at, env, push: async (to, messages) => (sent.push({ to, card: messages[0] }), { sent: true }) });
  return { ...result, sent };
}

test("the day before and 2 hours before, once each, with the customer's own link in LINE", { skip }, async () => {
  await inTx(async () => {
    const made = await lineBooking("11:00");
    const start = new Date(made.startAt).getTime();

    assert.equal((await run(new Date(start - 30 * HOUR))).sent.length, 0, "too early");

    const day = await run(new Date(start - 23 * HOUR));
    assert.equal(day.sent.length, 1);
    assert.equal(day.sent[0].to, LINE_USER);
    const dayTexts = texts(day.sent[0].card.contents);
    assert.ok(dayTexts.includes("🔔 พรุ่งนี้มีนัด"));
    assert.ok(dayTexts.includes(`https://liff.line.me/2010969802-QiiDBSxa/bloom-hair/manage/${made.manageToken}`));
    assert.equal((await run(new Date(start - 22 * HOUR))).sent.length, 0, "never twice");

    const soon = await run(new Date(start - 1 * HOUR));
    assert.equal(soon.sent.length, 1);
    assert.ok(texts(soon.sent[0].card.contents).includes("⏰ ใกล้ถึงเวลานัดแล้ว"));
    assert.equal((await run(new Date(start - 30 * 60 * 1000))).sent.length, 0);
    assert.equal((await run(new Date(start + 10 * 60 * 1000))).sent.length, 0, "not after it started");

    const { rows } = await db.query("select kind, result from public.booking_reminders where booking_id = $1 order by kind", [made.id]);
    assert.deepEqual(rows, [{ kind: "day", result: "sent" }, { kind: "soon", result: "sent" }]);
  });
});

test("a moved booking is reminded again for its new time", { skip }, async () => {
  await inTx(async () => {
    const made = await lineBooking("11:00");
    const start = new Date(made.startAt).getTime();
    assert.equal((await run(new Date(start - 23 * HOUR))).sent.length, 1);
    await manage.rescheduleManaged(db, "bloom-hair", made.manageToken, { date: DAY, time: "13:00" });
    const moved = start + 2 * HOUR;
    assert.equal((await run(new Date(moved - 23 * HOUR))).sent.length, 1, "the day-before card again, for 13:00");
  });
});

test("no reminder: booked after that moment, a web booking, not confirmed, or the shop switched them off", { skip }, async () => {
  await inTx(async () => {
    const late = await lineBooking("11:00");
    const start = new Date(late.startAt).getTime();
    await db.query("update public.bookings set created_at = $2 where id = $1", [late.id, new Date(start - 10 * HOUR).toISOString()]);
    assert.equal((await run(new Date(start - 23 * HOUR))).sent.length, 0, "booked 10 hours ahead: no day-before card");
    assert.equal((await run(new Date(start - 1 * HOUR))).sent.length, 1, "but the 2-hour one");

    const web = await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "13:00" }, customer: { name: "เว็บ", phone: "0812345678" } });
    const webStart = new Date(web.startAt).getTime();
    assert.equal((await run(new Date(webStart - 23 * HOUR))).sent.length, 0, "no LINE id");

    const off = await lineBooking("15:00");
    const offStart = new Date(off.startAt).getTime();
    await db.query("update public.business_booking_settings set line_reminders = false where business_id = $1", [SALON]);
    assert.equal((await run(new Date(offStart - 23 * HOUR))).sent.length, 0, "the shop switched them off");
    await db.query("update public.business_booking_settings set line_reminders = true where business_id = $1", [SALON]);
    await manage.cancelManaged(db, "bloom-hair", off.manageToken, {});
    assert.equal((await run(new Date(offStart - 23 * HOUR))).sent.length, 0, "cancelled");
  });
});

test("a card LINE refuses is recorded and not tried again; members can read, nobody writes", { skip }, async () => {
  await inTx(async () => {
    const made = await lineBooking("11:00");
    const start = new Date(made.startAt).getTime();
    const refused = await sendDueReminders(db, { now: new Date(start - 23 * HOUR), env, push: async () => ({ sent: false, reason: "LINE_REFUSED" }) });
    assert.deepEqual([refused.checked, refused.sent], [1, 0]);
    assert.equal((await run(new Date(start - 22 * HOUR))).sent.length, 0);
    const { rows } = await db.query("select result from public.booking_reminders where booking_id = $1", [made.id]);
    assert.deepEqual(rows, [{ result: "LINE_REFUSED" }]);

    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', '{\"sub\":\"e8600000-0000-4000-8000-000000000001\"}', true)");
    await db.query("savepoint w");
    await assert.rejects(db.query("insert into public.booking_reminders (business_id, booking_id, kind) values ($1, $2, 'soon')", [SALON, made.id]), (e) => e.code === "42501");
    await db.query("rollback to savepoint w");
    await db.query("reset role");
    await db.query("set local role anon");
    await db.query("savepoint r");
    await assert.rejects(db.query("select * from public.booking_reminders"), (e) => e.code === "42501");
    await db.query("rollback to savepoint r");
    await db.query("reset role");
  });
});
