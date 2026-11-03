// Slips checked automatically (migration …003300) against the test database: the reading service is
// faked; the slip is judged against the booking, the result is kept and shown to the shop, and a shop
// that allows it gets the deposit confirmed by a slip that passes. Rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const bills = require("../../src/v2/admin-bills");
const { book, shopInfo } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const BARBER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001"; // 450
const NAN = "a1000000-0000-4000-8000-000000000001";
const BEE = "a1000000-0000-4000-8000-000000000002";
const OWNER = { id: "e8430000-0000-4000-8000-00000000000a", email: "owner@deposit.test" };
const DESK = { id: "e8430000-0000-4000-8000-00000000000b", email: "desk@deposit.test" };
const OTHER = { id: "e8430000-0000-4000-8000-00000000000c", email: "barber@deposit.test" };
const SLIP = Buffer.from("RIFF0000WEBPVP8 fake slip bytes");
const BANK = { bank: "กสิกรไทย", accountNumber: "123-4-56789-0", accountName: "บลูม แฮร์", promptPay: "0812345678" };

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

async function as(user, slug = "bloom-hair") {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, slug);
}

async function asCustomer() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

async function shopSettings(shop) {
  const { settings } = await admin.getCatalog(db, shop);
  return { minLeadMinutes: settings.minLeadMinutes, slotIntervalMinutes: settings.slotIntervalMinutes, maxAdvanceDays: settings.maxAdvanceDays, holdMinutes: 60 };
}

// The salon asks for a deposit (fixed 200 by default)
async function inTx(fn, deposit = { depositMode: "fixed", depositValue: 200 }) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6)", [OWNER.id, OWNER.email, DESK.id, DESK.email, OTHER.id, OTHER.email]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SALON, BARBER, OWNER.id, DESK.id, OTHER.id]
    );
    const shop = await as(OWNER);
    const catalog = await admin.getCatalog(db, shop);
    await admin.saveShop(db, shop, { name: catalog.shop.name, kind: catalog.shop.kind, settings: { ...(await shopSettings(shop)), ...deposit, paymentInfo: BANK } });
    await asCustomer();
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

const { checkSlip } = require("../../src/v2/slip-check");
const { clearCache } = require("../../src/v2/platform-settings");

const booking = (time) => ({ selected: { offeringId: CUT, resourceId: NAN, date: DAY, time }, customer: { name: "ลูกค้ามัดจำ", phone: "0812345678" } });
const env = { ...process.env, EASYSLIP_API_KEY: "test-key-123456" };
const JPEG = Buffer.from("fake jpeg");

// the reading service, faked: what the bank slip says
function service({ amount = 200, transRef = "REF-0001", proxy = "xxx-xxx-5678", minutesAgo = 0, duplicate = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return {
      status: 200,
      json: async () => ({ status: 200, data: { isDuplicate: duplicate, rawSlip: { transRef, date: new Date(Date.now() - minutesAgo * 60000).toISOString(), amount: { amount }, receiver: { account: { name: { th: "บลูม แฮร์" }, proxy: { account: proxy } } } } } })
    };
  };
  return { calls, check: (db_, id, jpeg, options) => checkSlip(db_, id, jpeg, { ...options, env, fetchImpl }) };
}
const send = async (made, svc, options = {}) => {
  await asCustomer();
  clearCache();
  return manage.submitSlip(db, "bloom-hair", made.manageToken, SLIP, { jpeg: JPEG, check: svc.check, ...options });
};

test("a slip that passes: shown to the shop as passed; the shop still confirms (default)", { skip }, async () => {
  await inTx(async () => {
    const made = await book(db, "bloom-hair", booking("11:00"));
    const svc = service();
    const sent = await send(made, svc);
    assert.deepEqual(sent.slipCheck, { status: "passed", confirmed: false, reasons: [] });
    assert.equal(sent.booking.status, "pending", "waits for the shop");
    assert.equal(svc.calls[0].auth, "Bearer test-key-123456");
    assert.ok(svc.calls[0].body.base64.startsWith("data:image/jpeg;base64,"));

    const desk = await as(DESK);
    const listed = (await bookings.listBookings(db, desk, { from: DAY })).find((b) => b.id === made.id);
    assert.equal(listed.slipCheck.status, "passed");
    assert.equal(listed.slipCheck.amount, 200);
    assert.match(listed.slipCheck.receiver, /บลูม แฮร์ · xxx-xxx-5678/);
  });
});

test("a shop that allows it: a passing slip confirms the deposit onto the bill and tells the customer", { skip }, async () => {
  await inTx(async () => {
    const owner = await as(OWNER);
    const catalog = await admin.getCatalog(db, owner);
    await admin.saveShop(db, owner, { name: catalog.shop.name, kind: catalog.shop.kind, settings: { ...catalog.settings, holdMinutes: 60, slipAutoConfirm: true } });
    assert.equal((await admin.getCatalog(db, owner)).settings.slipAutoConfirm, true);
    await asCustomer();
    const made = await book(db, "bloom-hair", booking("11:00"));
    const told = [];
    const sent = await send(made, service(), { onConfirmed: async (id) => told.push(id) });
    assert.deepEqual([sent.slipCheck.confirmed, sent.booking.status], [true, "confirmed"]);
    assert.deepEqual(told, [made.id]);
    const { rows } = await db.query("select p.kind, p.amount::float8 as amount from public.bill_payments p join public.bills b on b.id = p.bill_id where b.booking_id = $1", [made.id]);
    assert.deepEqual(rows, [{ kind: "deposit", amount: 200 }]);

    // the same transfer for another booking: refused as a duplicate, not confirmed
    const other = await book(db, "bloom-hair", booking("14:00"));
    const again = await send(other, service());
    assert.deepEqual([again.slipCheck.status, again.slipCheck.reasons, again.booking.status], ["failed", ["DUPLICATE"], "pending"]);

    // too little, to someone else: failed with both reasons
    const third = await book(db, "bloom-hair", booking("16:00"));
    const wrong = await send(third, service({ amount: 100, transRef: "REF-0003", proxy: "xxx-xxx-0000" }));
    assert.deepEqual([wrong.slipCheck.status, wrong.slipCheck.reasons.sort()], ["failed", ["AMOUNT_LOW", "RECEIVER_MISMATCH"]]);
    assert.equal(wrong.booking.status, "pending");
  });
});

test("no key: nothing leaves the server and nothing is checked; only the server records checks", { skip }, async () => {
  await inTx(async () => {
    const made = await book(db, "bloom-hair", booking("11:00"));
    let called = false;
    await asCustomer();
    clearCache();
    const sent = await manage.submitSlip(db, "bloom-hair", made.manageToken, SLIP, {
      jpeg: JPEG,
      check: (db_, id, jpeg, o) => checkSlip(db_, id, jpeg, { ...o, env: { ...process.env, EASYSLIP_API_KEY: "" }, fetchImpl: async () => { called = true; } })
    });
    assert.equal(sent.slipCheck, undefined);
    assert.equal(called, false);

    const desk = await as(DESK);
    const { rows: [slip] } = await db.query("select id from public.payment_slips where booking_id = $1", [made.id]);
    await refused(() => db.query("select public.slip_record_check($1, 'passed', '{}', 'X', 1, now(), null)", [slip.id]), (e) => e.code === "42501");
    await as(OTHER, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.payment_slips where booking_id = $1", [made.id])).rows[0].n, 0);
    await db.query("reset role");
  });
});
