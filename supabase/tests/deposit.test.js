// Transfer deposits (migration …002200) against the test database: the shop sets a deposit, the
// customer books (held) and sends a slip from their link, the shop confirms and the deposit lands on
// the bill. Rolled-back transactions; the customer runs with no signed-in user.
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
const OWNER = { id: "e8400000-0000-4000-8000-00000000000a", email: "owner@deposit.test" };
const DESK = { id: "e8400000-0000-4000-8000-00000000000b", email: "desk@deposit.test" };
const OTHER = { id: "e8400000-0000-4000-8000-00000000000c", email: "barber@deposit.test" };
const SLIP = Buffer.from("RIFF0000WEBPVP8 fake slip bytes");
const BANK = { bank: "กสิกรไทย", accountNumber: "123-4-56789-0", accountName: "บลูม แฮร์", note: "โอนแล้วแนบสลิป" };

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

const booking = (time, resourceId = NAN) => ({ selected: { offeringId: CUT, resourceId, date: DAY, time }, customer: { name: "ลูกค้ามัดจำ", phone: "0812345678" } });

test("a held booking shows the deposit and where to transfer; the slip waits for the shop, which confirms it onto the bill", { skip }, async () => {
  await inTx(async () => {
    assert.deepEqual((await shopInfo(db, "bloom-hair")).deposit, { mode: "fixed", value: 200, holdMinutes: 60, allowFull: true });
    const made = await book(db, "bloom-hair", booking("11:00"));
    assert.equal(made.status, "held");
    assert.deepEqual(made.deposit, { due: 200, paymentInfo: BANK });
    const minutes = (new Date(made.holdExpiresAt) - Date.now()) / 60000;
    assert.ok(minutes > 58 && minutes <= 60, "held for the shop's hold minutes");

    const sent = await manage.submitSlip(db, "bloom-hair", made.manageToken, SLIP);
    assert.equal(sent.booking.status, "pending");
    assert.equal(sent.booking.holdExpiresAt, null, "a sent slip no longer runs out");
    assert.deepEqual([sent.booking.deposit.due, sent.booking.deposit.slips, sent.booking.deposit.paymentInfo.bank], [200, 1, "กสิกรไทย"]);

    const desk = await as(DESK);
    const listed = (await bookings.listBookings(db, desk, { from: DAY })).find((b) => b.id === made.id);
    assert.deepEqual([listed.status, listed.depositDue, listed.slips], ["pending", 200, 1]);
    const slip = await bookings.getSlip(db, desk, made.id);
    assert.ok(slip.image.equals(SLIP));
    assert.equal(slip.total, 1);

    await bookings.confirmDeposit(db, desk, made.id);
    const { bills: list } = await bills.listBills(db, desk, { from: DAY });
    const bill = (await db.query("select b.id, b.total::float8 as total, (select sum(amount)::float8 from public.bill_payments p where p.bill_id = b.id and p.kind = 'deposit') as deposit from public.bills b where b.booking_id = $1", [made.id])).rows[0];
    assert.deepEqual([bill.total, bill.deposit], [450, 200]);
    assert.ok(Array.isArray(list));
    // at the visit the customer pays the rest
    await bills.checkoutBooking(db, desk, made.id, { payments: [{ method: "cash", amount: 250 }] });
    const after = await db.query("select status from public.bills where id = $1", [bill.id]);
    assert.equal(after.rows[0].status, "closed");

    await asCustomer();
    const mine = await manage.findManaged(db, "bloom-hair", made.manageToken);
    assert.equal(mine.booking.status, "completed");
    assert.equal(mine.booking.deposit.paymentInfo, null, "no transfer details once it is paid");
  });
});

test("percentage and full deposits; no deposit set = the booking is confirmed straight away", { skip }, async () => {
  await inTx(async () => {
    assert.equal((await book(db, "bloom-hair", booking("11:00"))).deposit.due, 135); // 30% of 450
  }, { depositMode: "percent", depositValue: 30 });
  await inTx(async () => {
    assert.equal((await book(db, "bloom-hair", booking("11:00"))).deposit.due, 450);
  }, { depositMode: "full" });
  await inTx(async () => {
    const plain = await book(db, "bloom-hair", booking("11:00"));
    assert.deepEqual([plain.status, plain.deposit], ["confirmed", null]);
    assert.equal((await shopInfo(db, "bloom-hair")).deposit, null);
  }, { depositMode: "none" });
});

test("the customer may pay in full instead of the deposit: the due is the price, nothing is left at the desk", { skip }, async () => {
  await inTx(async () => {
    assert.equal((await shopInfo(db, "bloom-hair")).deposit.allowFull, true, "on by default");
    const full = await book(db, "bloom-hair", { ...booking("11:00"), payFull: true });
    assert.deepEqual([full.status, full.deposit.due, full.deposit.payFull], ["held", 450, true]);
    const plain = await book(db, "bloom-hair", booking("13:00"));
    assert.deepEqual([plain.deposit.due, plain.deposit.payFull], [200, undefined], "not asked: the deposit");

    const sent = await manage.submitSlip(db, "bloom-hair", full.manageToken, SLIP);
    assert.deepEqual([sent.booking.deposit.due, sent.booking.deposit.payFull], [450, true]);
    const desk = await as(DESK);
    await bookings.confirmDeposit(db, desk, full.id);
    await bills.checkoutBooking(db, desk, full.id, { payments: [] });
    const bill = (await db.query("select status, total::float8 as total, (select sum(amount)::float8 from public.bill_payments p where p.bill_id = b.id) as paid from public.bills b where b.booking_id = $1", [full.id])).rows[0];
    assert.deepEqual([bill.status, bill.total, bill.paid], ["closed", 450, 450]);

    // the server alone raises the due
    await refused(() => db.query("select public.booking_pay_full($1, 0)", [plain.id]), (e) => e.code === "42501"); // a member of the shop, too
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select public.booking_pay_full($1, 0)", [plain.id]), (e) => e.code === "42501");
    await db.query("reset role");
    // only a held booking of a shop that allows it
    await refused(() => db.query("select public.booking_pay_full($1, 0)", [full.id]), (e) => e.code === "BK422");
  });
  // the shop switched it off: the deposit, whatever the page sent
  await inTx(async () => {
    assert.equal((await shopInfo(db, "bloom-hair")).deposit.allowFull, false);
    const made = await book(db, "bloom-hair", { ...booking("11:00"), payFull: true });
    assert.deepEqual([made.deposit.due, made.deposit.payFull], [200, undefined]);
    const shop = await as(OWNER);
    assert.equal((await admin.getCatalog(db, shop)).settings.depositAllowFull, false);
  }, { depositMode: "fixed", depositValue: 200, depositAllowFull: false });
  // a percentage too; a shop that already takes the whole price has nothing to choose
  await inTx(async () => {
    assert.equal((await book(db, "bloom-hair", { ...booking("11:00"), payFull: true })).deposit.due, 450);
  }, { depositMode: "percent", depositValue: 30 });
  await inTx(async () => {
    assert.equal((await shopInfo(db, "bloom-hair")).deposit.allowFull, false);
  }, { depositMode: "full" });
});

test("ฝากถึงร้าน: the customer's note is kept with the booking for the shop only, tidied and capped at 300", { skip }, async () => {
  await inTx(async () => {
    const made = await book(db, "bloom-hair", { ...booking("11:00"), customer: { ...booking("11:00").customer, note: "  ขอสระน้ำอุ่น \n ด้วยนะคะ  " } });
    const long = await book(db, "bloom-hair", { ...booking("13:00"), customer: { ...booking("13:00").customer, note: "ก".repeat(400) } });
    const none = await book(db, "bloom-hair", booking("15:00", BEE));
    const desk = await as(DESK);
    const list = await bookings.listBookings(db, desk, { from: DAY });
    assert.equal(list.find((b) => b.id === made.id).note, "ขอสระน้ำอุ่น ด้วยนะคะ");
    assert.equal(list.find((b) => b.id === long.id).note.length, 300);
    assert.equal(list.find((b) => b.id === none.id).note, null);
    // another shop's owner sees no booking of this shop, so no note; anon reads no bookings at all
    await as(OTHER, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.bookings where customer_note is not null")).rows[0].n, 0);
    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select customer_note from public.bookings"), (e) => e.code === "42501");
  }, { depositMode: "none" });
});

test("a shop that takes PromptPay gets a QR with the deposit filled in, until the slip is sent", { skip }, async () => {
  const { promptPayPayload } = require("../../src/v2/promptpay");
  await inTx(async () => {
    const shop = await as(OWNER);
    const catalog = await admin.getCatalog(db, shop);
    await admin.saveShop(db, shop, { name: catalog.shop.name, kind: catalog.shop.kind, settings: { ...(await shopSettings(shop)), depositMode: "fixed", depositValue: 200, paymentInfo: { promptPay: "081-234-5678", accountName: "บลูม แฮร์" } } });
    await asCustomer();
    const made = await book(db, "bloom-hair", booking("11:00"));
    assert.match(made.deposit.qr, /^data:image\/png;base64,/);
    assert.match(promptPayPayload("081-234-5678", made.deposit.due), /5406200\.00/);

    const held = await manage.findManaged(db, "bloom-hair", made.manageToken);
    assert.match(held.booking.deposit.qr, /^data:image\/png;base64,/);
    const sent = await manage.submitSlip(db, "bloom-hair", made.manageToken, SLIP);
    assert.equal(sent.booking.deposit.qr, undefined, "no QR once the slip is sent");
  });
  // bank account only: no QR
  await inTx(async () => {
    const made = await book(db, "bloom-hair", booking("11:00"));
    assert.equal(made.deposit.qr, undefined);
  });
});

test("settings are checked in words: an account to transfer to, sensible amounts", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(OWNER);
    const catalog = await admin.getCatalog(db, shop);
    assert.deepEqual([catalog.settings.depositMode, catalog.settings.depositValue, catalog.settings.paymentInfo], ["fixed", 200, BANK]);
    const base = { name: catalog.shop.name, kind: catalog.shop.kind };
    const bad = (settings, pattern) =>
      refused(() => admin.saveShop(db, shop, { ...base, settings: { ...(catalog.settings), ...settings } }), (e) => e.status === 422 && pattern.test(e.message));
    await bad({ paymentInfo: {} }, /เลขบัญชีหรือพร้อมเพย์/);
    await bad({ depositMode: "percent", depositValue: 150 }, /1–100/);
    await bad({ depositValue: 0 }, /มากกว่า 0/);
    await bad({ paymentInfo: { accountNumber: "abc" } }, /เลขบัญชี/);
    await bad({ paymentInfo: { promptPay: "12345" } }, /พร้อมเพย์/);
    await admin.saveShop(db, shop, { ...base, settings: { ...catalog.settings, paymentInfo: { promptPay: "0812345678" } } });
  });
});

test("a hold that ran out takes no slip; a sixth slip is refused; a cancelled booking takes none", { skip }, async () => {
  await inTx(async () => {
    const late = await book(db, "bloom-hair", booking("11:00"));
    await db.query("update public.bookings set hold_expires_at = now() - interval '1 second' where id = $1", [late.id]);
    await refused(() => manage.submitSlip(db, "bloom-hair", late.manageToken, SLIP), (e) => e.status === 409 && e.details.reason === "HOLD_EXPIRED");

    const many = await book(db, "bloom-hair", booking("13:00"));
    for (let i = 0; i < 5; i++) await manage.submitSlip(db, "bloom-hair", many.manageToken, SLIP);
    await refused(() => manage.submitSlip(db, "bloom-hair", many.manageToken, SLIP), (e) => e.status === 422 && e.details.reason === "TOO_MANY_SLIPS");

    const gone = await book(db, "bloom-hair", booking("15:00", BEE));
    await manage.cancelManaged(db, "bloom-hair", gone.manageToken, {});
    await refused(() => manage.submitSlip(db, "bloom-hair", gone.manageToken, SLIP), (e) => e.status === 422);
  });
});

test("slips are the shop's to see: not anon, not another shop, and nobody writes them directly", { skip }, async () => {
  await inTx(async () => {
    const made = await book(db, "bloom-hair", booking("11:00"));
    await manage.submitSlip(db, "bloom-hair", made.manageToken, SLIP);

    const other = await as(OTHER, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.payment_slips")).rows[0].n, 0, "RLS hides another shop's slips");
    await refused(() => bookings.getSlip(db, other, made.id), (e) => e.status === 404);
    await refused(() => db.query("select public.confirm_deposit($1)", [made.id]), (e) => e.code === "42501");
    await refused(() => db.query("select public.customer_submit_slip($1, $2, $3)", [SALON, "a".repeat(64), SLIP]), (e) => e.code === "42501");
    await refused(() => db.query("select public.booking_deposit_due($1, 100)", [SALON]), (e) => e.code === "42501");

    await as(DESK);
    await refused(() => db.query("insert into public.payment_slips (business_id, booking_id, image) values ($1, $2, $3)", [SALON, made.id, SLIP]), (e) => e.code === "42501");

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.payment_slips"), (e) => e.code === "42501");
  });
});
