// LINE booking cards end to end against the test database: a booking made inside LINE (LIFF) sends a
// card to that customer, with the link to their booking; a held booking asks for the deposit; the
// shop's deposit confirmation sends "ร้านยืนยันคิวแล้ว". Sending is stubbed; nothing leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const { book } = require("../../src/v2/public-booking");
const { clearCache } = require("../../src/v2/platform-settings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const OWNER = { id: "e8500000-0000-4000-8000-00000000000a", email: "owner@line-cards.test" };
const LINE_USER = `U${"b".repeat(32)}`;

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
    await db.query("insert into auth.users (id, email) values ($1, $2)", [OWNER.id, OWNER.email]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')", [SALON, OWNER.id]);
    await db.query("insert into public.platform_settings (key, value, is_secret) values ('line.liff_id', '2010969802-QiiDBSxa', false) on conflict (key) do update set value = excluded.value");
    clearCache();
    return await fn();
  } finally {
    await db.query("rollback");
    clearCache();
  }
}

const texts = (node) => (node && typeof node === "object" ? [node.text, node.action?.uri, ...Object.values(node).flatMap(texts)].filter((t) => typeof t === "string") : []);
const fromLine = { verifyLineToken: async () => ({ sub: LINE_USER, name: "มาลี LINE" }) };
const request = (time) => ({ selected: { offeringId: CUT, resourceId: NAN, date: DAY, time }, customer: { name: "มาลี LINE" }, lineIdToken: "token-from-liff" });

test("booked inside LINE: the card goes to that customer with the LIFF link to their booking", { skip }, async () => {
  await inTx(async () => {
    const sent = [];
    const made = await book(db, "bloom-hair", request("11:00"), { ...fromLine, notifyLine: async (to, messages) => (sent.push({ to, messages }), { sent: true }) });
    assert.deepEqual(made.line, { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, LINE_USER);
    const all = texts(sent[0].messages[0].contents);
    assert.ok(all.includes("✓ จองสำเร็จ"));
    assert.ok(all.includes("ตัดผมหญิง + สระไดร์"));
    assert.ok(all.includes(`https://liff.line.me/2010969802-QiiDBSxa/bloom-hair/manage/${made.manageToken}`));

    // a booking from the web (no LINE) sends nothing
    const web = await book(db, "bloom-hair", { ...request("13:00"), lineIdToken: undefined, customer: { name: "เว็บ", phone: "0812345678" } }, {
      notifyLine: async () => assert.fail("no card without LINE")
    });
    assert.equal(web.line, undefined);
  });
});

test("a deposit to transfer: the card says how much and by when; the shop's confirmation sends the next card", { skip }, async () => {
  await inTx(async () => {
    await db.query(
      `update public.business_booking_settings set deposit_mode = 'fixed', deposit_value = 200, hold_minutes = 60,
              payment_info = '{"accountNumber":"123-4-56789-0"}' where business_id = $1`,
      [SALON]
    );
    const sent = [];
    const made = await book(db, "bloom-hair", request("11:00"), { ...fromLine, notifyLine: async (to, messages) => (sent.push(messages[0]), { sent: true }) });
    assert.equal(made.status, "held");
    const held = texts(sent[0].contents);
    assert.ok(held.includes("⏳ กันคิวไว้ให้แล้ว"));
    assert.ok(held.some((t) => /^โอนมัดจำ 200 บาท ภายใน \d\d:\d\d น\.$/.test(t)));

    await admin.actAs(db, OWNER);
    const shop = await admin.memberShop(db, "bloom-hair");
    await bookings.confirmDeposit(db, shop, made.id);
    const next = await bookings.lineCard(db, shop, made.id, "confirmed");
    assert.equal(next.to, LINE_USER);
    assert.ok(texts(next.card.contents).includes("✓ ร้านยืนยันคิวแล้ว"));

    // a walk-in the shop typed in has no LINE id: nothing to send
    const desk = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "15:00", customer: { name: "โทรมา" } });
    assert.equal(await bookings.lineCard(db, shop, desk.id, "confirmed"), null);
  });
});

test("a card that cannot be sent never fails the booking", { skip }, async () => {
  await inTx(async () => {
    const made = await book(db, "bloom-hair", request("11:00"), { ...fromLine, notifyLine: async () => { throw new Error("LINE is down"); } });
    assert.ok(made.id);
    assert.deepEqual(made.line, { sent: false, reason: "ERROR" });
  });
});

test("the shop moves or cancels from the dashboard: the LINE customer gets a card (moved → their link, cancelled → book again)", { skip }, async () => {
  const env = { ...process.env, SETTINGS_ENCRYPTION_KEY: "c".repeat(40) };
  const before = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = env.SETTINGS_ENCRYPTION_KEY; // book() seals the customer's link with it
  try {
    await inTx(async () => {
      const made = await book(db, "bloom-hair", request("11:00"), { ...fromLine, notifyLine: async () => ({ sent: true }) });
      await admin.actAs(db, OWNER);
      const shop = await admin.memberShop(db, "bloom-hair");
      const sent = [];
      const push = async (to, messages) => (sent.push({ to, card: messages[0] }), { sent: true });

      const moved = await bookings.rescheduleBooking(db, shop, made.id, { date: DAY, time: "14:00" });
      assert.ok(moved.previous, "the old time comes back for the card");
      assert.deepEqual(await bookings.notifyChange(db, shop, made.id, "moved", { previous: moved.previous, db, env, push }), { sent: true });
      const m = texts(sent[0].card.contents);
      assert.equal(sent[0].to, LINE_USER);
      assert.ok(m.includes("📅 ร้านเลื่อนนัดให้แล้ว"));
      assert.ok(m.some((t) => /^14:00–/.test(t)), "the new time");
      assert.ok(m.some((t) => /11:00–.* น\.$/.test(t)), "and where it was (จากเดิม)");
      assert.ok(m.includes("จากเดิม"));
      assert.ok(m.includes(`https://liff.line.me/2010969802-QiiDBSxa/bloom-hair/manage/${made.manageToken}`));

      // same time, another stylist: no "จากเดิม"
      const same = await bookings.rescheduleBooking(db, shop, made.id, { date: DAY, time: "14:00", resourceId: "a1000000-0000-4000-8000-000000000002" });
      assert.equal(same.previous, null);

      const cancelled = await bookings.cancelBooking(db, shop, made.id, { reason: "สนามปิดซ่อม" });
      await bookings.notifyChange(db, shop, made.id, "cancelled", { reason: cancelled.reason, db, env, push });
      const c = texts(sent[1].card.contents);
      assert.ok(c.includes("✕ นัดถูกยกเลิก"));
      assert.ok(c.includes("สนามปิดซ่อม"));
      assert.ok(c.includes("https://liff.line.me/2010969802-QiiDBSxa/bloom-hair"), "book again");
      assert.ok(!c.some((t) => /บาท$/.test(t)), "no price on a cancelled card");

      // a walk-in typed in by the shop: nothing to send; LINE down: the change stands, the card says why
      const desk = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time: "16:00", customer: { name: "โทรมา" } });
      assert.equal(await bookings.notifyChange(db, shop, desk.id, "cancelled", { db, env, push }), null);
      await db.query("reset role"); // the customer books through the server's connection
      const other = await book(db, "bloom-hair", request("11:00"), { ...fromLine, notifyLine: async () => ({ sent: true }) });
      await admin.actAs(db, OWNER);
      const failed = await bookings.notifyChange(db, shop, other.id, "moved", { db, env, push: async () => { throw new Error("LINE is down"); } });
      assert.deepEqual(failed, { sent: false, reason: "ERROR" });
    });
  } finally {
    if (before === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = before;
  }
});
