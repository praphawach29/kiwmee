// Bills (src/v2/admin-bills.js, migration …001000) against the test database, as a signed-in member
// exactly as app/api/dashboard/shops/[slug]/bills* and …/bookings/[id]/checkout do, in rolled-back
// transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const bills = require("../../src/v2/admin-bills");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SHOP_A = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const SHOP_B = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001"; // 60 min, 450
const NAN = "a1000000-0000-4000-8000-000000000001";

const USERS = {
  staffA: { id: "e5000000-0000-4000-8000-00000000000a", email: "desk@bills.test" },
  ownerA: { id: "e5000000-0000-4000-8000-00000000000b", email: "owner-a@bills.test" },
  ownerB: { id: "e5000000-0000-4000-8000-00000000000c", email: "owner-b@bills.test" }
};

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

function bangkokDate(ahead = 0, weekday) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  if (weekday !== undefined) while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokDate(2, 2); // a Tuesday ahead: everyone works
const TODAY = bangkokDate();

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $3, 'staff'), ($1, $4, 'owner'), ($2, $5, 'owner')",
      [SHOP_A, SHOP_B, USERS.staffA.id, USERS.ownerA.id, USERS.ownerB.id]
    );
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

// Switch the signed-in user inside the test transaction
async function as(user) {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, user === USERS.ownerB ? "gentleman-barber" : "bloom-hair");
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

const book = (shop, time, extra = {}) =>
  bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: DAY, time, customer: { name: "คุณบิล" }, ...extra });

test("closing a booking's bill takes the payment and completes the booking, once", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.staffA);
    const { id } = await book(shop, "10:00");

    // the money has to match the total
    await refused(
      () => bills.checkoutBooking(db, shop, id, { payments: [{ method: "cash", amount: 400 }] }),
      (e) => e.status === 422 && e.details.reason === "PAYMENT_MISMATCH" && e.message === "ยอดที่รับไม่ตรงกับยอดที่ต้องชำระ"
    );
    let [row] = await bookings.listBookings(db, shop, { from: DAY });
    assert.deepEqual([row.status, row.bill], ["confirmed", null], "nothing was kept from the refused close");

    const bill = await bills.checkoutBooking(db, shop, id, {
      payments: [{ method: "cash", amount: 200 }, { method: "transfer", amount: "250" }, { method: "card", amount: 0 }],
      note: "ทิปช่าง 20"
    });
    assert.deepEqual([bill.status, Number(bill.total), Number(bill.paid), bill.title], ["closed", 450, 450, "ตัดผมหญิง + สระไดร์"]);
    [row] = await bookings.listBookings(db, shop, { from: DAY });
    assert.equal(row.status, "completed");
    assert.deepEqual(row.bill, { id: bill.id, status: "closed", total: 450, paid: 450 });
    assert.equal(row.statusReason, "ปิดบิล");

    await refused(() => bills.checkoutBooking(db, shop, id, { payments: [{ method: "cash", amount: 450 }] }), (e) => e.details.reason === "ALREADY_CLOSED");
    await refused(() => bookings.setStatus(db, shop, id, { status: "checked_in" }), (e) => e.status === 422 && /ปิดบิลแล้ว/.test(e.message));
  });
});

test("the shop changes the amount at checkout; cancelled bookings and bad payments are refused", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.staffA);
    const { id } = await book(shop, "10:00");
    await bookings.setStatus(db, shop, id, { status: "checked_in" });
    const bill = await bills.checkoutBooking(db, shop, id, { subtotal: 650, payments: [{ method: "cash", amount: 650 }] });
    assert.equal(Number(bill.total), 650, "the customer added a treatment");

    const other = await book(shop, "13:00");
    await bookings.cancelBooking(db, shop, other.id, {});
    await refused(() => bills.checkoutBooking(db, shop, other.id, { payments: [{ method: "cash", amount: 450 }] }), (e) => e.details.reason === "NOT_CHANGEABLE");

    const third = await book(shop, "15:00");
    await refused(() => bills.checkoutBooking(db, shop, third.id, { payments: [{ method: "bitcoin", amount: 450 }] }), (e) => e.status === 422);
    await refused(() => bills.checkoutBooking(db, shop, third.id, { subtotal: -1, payments: [] }), (e) => e.status === 422);
  });
});

test("a walk-in sale without a booking, and the day's takings", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.staffA);
    const sale = await bills.createSale(db, shop, {
      title: "ก๋วยเตี๋ยวต้มยำ 2 ชาม",
      customerName: "ลูกค้าหน้าร้าน",
      amount: 120,
      payments: [{ method: "cash", amount: 100 }, { method: "transfer", amount: 20 }]
    });
    assert.deepEqual([sale.status, Number(sale.total), sale.booking_id, sale.customer_name], ["closed", 120, null, "ลูกค้าหน้าร้าน"]);
    const free = await bills.createSale(db, shop, { amount: 0, payments: [] });
    assert.deepEqual([free.status, free.title], ["closed", "ขายหน้าร้าน"], "a free visit (a reward, later) closes with nothing to pay");

    const day = await bills.listBills(db, shop, { from: TODAY });
    assert.equal(day.bills.length, 2);
    assert.deepEqual(day.bills.find((b) => b.id === sale.id).payments.map((p) => [p.method, p.amount]), [["cash", 100], ["transfer", 20]]);
    assert.deepEqual(day.summary, { byMethod: { cash: 100, transfer: 20, card: 0, online: 0 }, received: 120, refunds: 0, net: 120, closedBills: 2 });
    await refused(() => bills.createSale(db, shop, { amount: 120, payments: [{ method: "cash", amount: 100 }] }), (e) => e.details.reason === "PAYMENT_MISMATCH");
  });
});

test("only the owner refunds, never more than was paid", { skip }, async () => {
  await inTx(async () => {
    let shop = await as(USERS.staffA);
    const sale = await bills.createSale(db, shop, { amount: 300, payments: [{ method: "transfer", amount: 300 }] });
    await refused(() => bills.refundBill(db, shop, sale.id, { amount: 50, method: "cash" }), (e) => e.code === "42501");

    shop = await as(USERS.ownerA);
    const after = await bills.refundBill(db, shop, sale.id, { amount: 50, method: "cash", reason: "ผมสั้นเกิน" });
    assert.deepEqual([Number(after.paid), Number(after.refunded)], [300, 50]);
    await refused(() => bills.refundBill(db, shop, sale.id, { amount: 251, method: "transfer" }), (e) => e.details.reason === "REFUND_TOO_MUCH");
    await bills.refundBill(db, shop, sale.id, { amount: 250, method: "transfer" });
    const day = await bills.listBills(db, shop, { from: TODAY });
    assert.deepEqual([day.summary.received, day.summary.refunds, day.summary.net], [300, 300, 0]);
  });
});

test("another shop sees none of it; nobody writes bills around the RPCs", { skip }, async () => {
  await inTx(async () => {
    const shopA = await as(USERS.staffA);
    const sale = await bills.createSale(db, shopA, { amount: 99, payments: [{ method: "cash", amount: 99 }] });
    const { id } = await book(shopA, "10:00");

    const shopB = await as(USERS.ownerB);
    assert.deepEqual((await bills.listBills(db, shopB, { from: TODAY })).bills, []);
    await refused(() => bills.refundBill(db, shopB, sale.id, { amount: 1, method: "cash" }), (e) => e.status === 404);
    await refused(() => bills.checkoutBooking(db, shopB, id, { payments: [{ method: "cash", amount: 450 }] }), (e) => e.status === 404);
    // even with shop A's id, the RPCs refuse a non-member and RLS hides the rows
    const fake = { id: SHOP_A, timezone: "Asia/Bangkok" };
    await refused(() => bills.createSale(db, fake, { amount: 1, payments: [{ method: "cash", amount: 1 }] }), (e) => e.code === "42501");
    assert.deepEqual((await bills.listBills(db, fake, { from: TODAY })).bills, []);
    await refused(() => db.query("select public.refund_bill($1, 1, 'cash')", [sale.id]), (e) => e.code === "42501");

    await as(USERS.ownerA);
    await refused(
      () => db.query("insert into public.bills (business_id, title) values ($1, 'x')", [SHOP_A]),
      (e) => e.code === "42501"
    );
    await refused(() => db.query("update public.bill_payments set amount = 1"), (e) => e.code === "42501");

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.bills"), (e) => e.code === "42501");
    await refused(() => db.query(`select public.open_bill('${SHOP_A}')`), (e) => e.code === "42501");
  });
});

test("an open bill with no money on it can be voided", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.staffA);
    const { rows } = await db.query("select public.open_bill($1, null, 'เปิดผิด', 50) as id", [SHOP_A]);
    const voided = (await db.query("select public.void_bill($1, 'กดผิด') as b", [rows[0].id])).rows[0].b;
    assert.equal(voided.status, "void");
    await refused(() => db.query("select public.close_bill($1, '[]'::jsonb)", [rows[0].id]), (e) => e.code === "BK422" && e.message === "NOT_CHANGEABLE");
  });
});
