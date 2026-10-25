// The public booking API logic (src/v2/public-booking.js) against the test database: the same
// calls the /api/b/{slug}/* routes make, inside rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { shopInfo, step, book, rateLimit, cleanSelected } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const PLOY = "a1000000-0000-4000-8000-000000000003";
const MEN_CUT = "c2000000-0000-4000-8000-000000000001";

let db;

function bangkokDay(ahead, weekday) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  if (weekday !== undefined) while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokDay(3, 2);

test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

// An expected failure inside the test transaction, rolled back to a savepoint so the next call works
async function refused(promiseFn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(promiseFn(), check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

async function inTx(fn) {
  await db.query("begin");
  try {
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

test("shop info lists what the page needs and nothing private", { skip }, async () => {
  const salon = await shopInfo(db, "bloom-hair");
  assert.equal(salon.name, "Bloom Hair & Beauty");
  assert.deepEqual(salon.flow.entry, ["date", "offering"]);
  assert.equal(salon.flow.showAnyStaff, true);
  assert.deepEqual(salon.offerings.map((o) => [o.name, o.durationMinutes, o.price.amount]), [
    ["ตัดผมหญิง + สระไดร์", 60, 450],
    ["ทำสีผม", 120, 1500],
    ["ทรีตเมนต์บำรุงผม", 45, 600]
  ]);
  assert.deepEqual(salon.resources.map((r) => r.name), ["ช่างแนน", "ช่างบี", "ช่างพลอย (ทำสีเท่านั้น)"]);

  const barber = await shopInfo(db, "gentleman-barber");
  assert.deepEqual(barber.resources, [], "the barber assigns barbers itself");
  assert.deepEqual(barber.offerings[0].price, { amount: 200, unit: "per_booking", varies: true });

  await assert.rejects(shopInfo(db, "no-such-shop"), (e) => e.status === 404);
  await assert.rejects(shopInfo(db, "../etc"), (e) => e.status === 404);
});

test("the salon page: start page, then each way in walks to the customer form", { skip }, async () => {
  const first = await step(db, "bloom-hair", { selected: {} });
  assert.deepEqual(first.next, { step: "start", choices: ["date", "offering"] });
  assert.equal(first.ask, null);

  // from a date
  const dates = await step(db, "bloom-hair", { selected: {}, ask: "date" });
  assert.equal(dates.options.length, 31);
  let s = await step(db, "bloom-hair", { selected: { date: DAY }, changed: "date" });
  assert.equal(s.ask, "offering");
  s = await step(db, "bloom-hair", { selected: { ...s.selected, offeringId: CUT }, changed: "offering" });
  assert.equal(s.ask, "resource");
  assert.equal(s.options[0].value, null, "\"anyone\" first");
  s = await step(db, "bloom-hair", { selected: { ...s.selected, resourceId: null }, changed: "resource" });
  assert.equal(s.ask, "time");
  s = await step(db, "bloom-hair", { selected: { ...s.selected, time: s.options[0].value }, changed: "time" });
  assert.deepEqual(s.next, { step: "customer" });
  assert.equal(s.ask, null);

  // from an offering
  s = await step(db, "bloom-hair", { selected: { offeringId: CUT }, changed: "offering" });
  assert.equal(s.ask, "resource");
  s = await step(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN }, changed: "resource" });
  assert.equal(s.ask, "date");
});

test("changing an earlier choice clears what no longer fits, with the reason", { skip }, async () => {
  const s = await step(db, "bloom-hair", { selected: { offeringId: "c1000000-0000-4000-8000-000000000002", resourceId: PLOY, date: DAY, time: "11:00" }, changed: "offering" });
  // switched to colour → ช่างพลอย still fits, the time is cleared because the length changed
  assert.equal(s.selected.resourceId, PLOY);
  assert.equal(s.selected.time, undefined);
  const back = await step(db, "bloom-hair", { selected: { ...s.selected, offeringId: CUT }, changed: "offering" });
  assert.equal(back.selected.resourceId, undefined);
  assert.deepEqual(back.cleared.map((c) => [c.step, c.reason]), [["resource", "NOT_OFFERED"]]);
  assert.equal(back.ask, "resource");

  // Tapping the offering to change it lists every offering, not only what ช่างพลอย does
  const edit = await step(db, "bloom-hair", { selected: { offeringId: "c1000000-0000-4000-8000-000000000002", resourceId: PLOY }, ask: "offering" });
  assert.deepEqual(edit.options.map((o) => o.available), [true, true, true]);
});

test("selected values are type-checked before they reach the engine", { skip }, async () => {
  assert.deepEqual(cleanSelected({ offeringId: CUT, resourceId: null, extra: "x", partySize: 2 }), { offeringId: CUT, resourceId: null, partySize: 2 });
  assert.throws(() => cleanSelected({ partySize: "2" }), /whole number/);
  assert.throws(() => cleanSelected("x"), /object/);
  await assert.rejects(step(db, "bloom-hair", { selected: { offeringId: MEN_CUT } }), /unknown offering/);
  await assert.rejects(step(db, "bloom-hair", { selected: {}, ask: "payment" }), /unknown step/);
});

test("booking: confirmed with the stylist and price; incomplete or bad details are refused", { skip }, async () => {
  await inTx(async () => {
    const selected = { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00" };
    const b = await book(db, "bloom-hair", { selected, customer: { name: " คุณเอ ", phone: "081-234-5678" } });
    assert.equal(b.status, "confirmed");
    assert.deepEqual(b.resources, [{ id: NAN, name: "ช่างแนน" }]);
    assert.equal(b.price.total, 450);
    const row = (await db.query("select c.name, c.phone, b.source from public.bookings b join public.customers c on c.id = b.customer_id where b.id = $1", [b.id])).rows[0];
    assert.deepEqual(row, { name: "คุณเอ", phone: "0812345678", source: "web" });

    await refused(() => book(db, "bloom-hair", { selected, customer: { name: "คุณบี", phone: "0899999999" } }), (e) => e.status === 409 && e.message === "FULLY_BOOKED");
    await refused(() => book(db, "bloom-hair", { selected: { offeringId: CUT }, customer: { name: "x", phone: "0899999999" } }), (e) => e.code === "INCOMPLETE");
    await refused(() => book(db, "bloom-hair", { selected: { ...selected, time: "12:00" }, customer: { name: "", phone: "0899999999" } }), (e) => e.code === "INVALID_CUSTOMER");
    await refused(() => book(db, "bloom-hair", { selected: { ...selected, time: "12:00" }, customer: { name: "x", phone: "12345" } }), (e) => e.code === "INVALID_CUSTOMER");
    await refused(() => book(db, "bloom-hair", { selected: { ...selected, time: "19:30" }, customer: { name: "x", phone: "0899999999" } }), (e) => e.status === 422 && e.message === "NO_WORKING_WINDOW");
  });
});

test("booking from LINE: the verified LINE id is kept and the phone becomes optional", { skip }, async () => {
  await inTx(async () => {
    const selected = { offeringId: MEN_CUT, date: DAY, time: "10:00" };
    const verifyLineToken = async (token) => (token === "good" ? { sub: "U123", name: "ลูกค้าไลน์" } : null);
    const b = await book(db, "gentleman-barber", { selected, customer: { name: "ลูกค้าไลน์" }, lineIdToken: "good" }, { verifyLineToken });
    const row = (await db.query("select c.line_user_id, b.source from public.bookings b join public.customers c on c.id = b.customer_id where b.id = $1", [b.id])).rows[0];
    assert.deepEqual(row, { line_user_id: "U123", source: "liff" });
    await refused(() => book(db, "gentleman-barber", { selected: { ...selected, time: "11:00" }, customer: { name: "x" }, lineIdToken: "forged" }, { verifyLineToken }),
      (e) => e.status === 403
    );
  });
});

test("rate limits count per client and bucket", { skip }, async () => {
  await inTx(async () => {
    for (let i = 0; i < 3; i++) await rateLimit(db, "10.0.0.1", "test", 3, 60);
    await refused(() => rateLimit(db, "10.0.0.1", "test", 3, 60), (e) => e.status === 429);
    await rateLimit(db, "10.0.0.2", "test", 3, 60);
    await rateLimit(db, "10.0.0.1", "other", 3, 60);
  });
});
