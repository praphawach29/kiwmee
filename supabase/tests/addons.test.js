// Add-on settings (migration …002000, design §11 PR A): src/v2/admin-catalog.js saveAddonGroup /
// deleteAddonGroup run as the signed-in user, inside rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SHOP_A = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const SHOP_B = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const USERS = {
  ownerA: { id: "e8200000-0000-4000-8000-00000000000a", email: "owner-a@addons.test" },
  staffA: { id: "e8200000-0000-4000-8000-00000000000b", email: "staff-a@addons.test" },
  ownerB: { id: "e8200000-0000-4000-8000-00000000000c", email: "owner-b@addons.test" }
};

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

function bangkokDay(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SHOP_A, SHOP_B, USERS.ownerA.id, USERS.staffA.id, USERS.ownerB.id]
    );
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function as(user, slug = "bloom-hair") {
  await db.query("reset role");
  await admin.actAs(db, user);
  return admin.memberShop(db, slug);
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(async () => {
      try {
        await fn();
      } catch (error) {
        throw admin.dbError(error);
      }
    }, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

const EQUIPMENT = {
  name: "อุปกรณ์",
  minSelect: 0,
  maxSelect: null,
  offeringIds: [CUT],
  addons: [
    { name: "เช่าไม้", priceUnit: "per_unit", amount: 50, maxQuantity: 4, usesKind: "ไม้แบด" },
    { name: "ห้องอาบน้ำ", priceUnit: "per_booking", amount: 150 },
    { name: "ทรีตเมนต์เพิ่ม", priceUnit: "per_booking", amount: 200, addsMinutes: 15 }
  ]
};

test("an owner sets up a group of add-ons for an offering; staff read it but cannot change it", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.ownerA);
    const { id } = await admin.saveAddonGroup(db, shop, null, EQUIPMENT);
    let catalog = await admin.getCatalog(db, shop);
    const group = catalog.addonGroups.find((g) => g.id === id);
    assert.deepEqual([group.name, group.minSelect, group.maxSelect, group.offeringIds], ["อุปกรณ์", 0, null, [CUT]]);
    assert.deepEqual(
      group.addons.map((a) => [a.name, a.priceUnit, a.amount, a.maxQuantity, a.addsMinutes, a.usesKind]),
      [["เช่าไม้", "per_unit", 50, 4, 0, "ไม้แบด"], ["ห้องอาบน้ำ", "per_booking", 150, 1, 0, null], ["ทรีตเมนต์เพิ่ม", "per_booking", 200, 1, 15, null]]
    );
    assert.deepEqual(catalog.offerings.find((o) => o.id === CUT).addonGroupIds, [id]);

    // edit: one add-on renamed in place (same id), one dropped, the group becomes "pick one"
    const [racket, shower] = group.addons;
    await admin.saveAddonGroup(db, shop, id, {
      ...EQUIPMENT,
      maxSelect: 1,
      addons: [{ ...racket, name: "เช่าไม้แบด" }, shower]
    });
    catalog = await admin.getCatalog(db, shop);
    const edited = catalog.addonGroups.find((g) => g.id === id);
    assert.equal(edited.maxSelect, 1);
    assert.deepEqual(edited.addons.map((a) => [a.id, a.name]), [[racket.id, "เช่าไม้แบด"], [shower.id, "ห้องอาบน้ำ"]]);

    const staff = await as(USERS.staffA);
    assert.equal((await admin.getCatalog(db, staff)).addonGroups.length, 1, "staff read the add-ons");
    // the route asks for an owner first; under it, RLS lets staff change nothing
    await refused(() => admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
    await refused(() => admin.saveAddonGroup(db, staff, id, EQUIPMENT), (e) => e.status === 404);
    await refused(() => admin.saveAddonGroup(db, staff, null, EQUIPMENT), (e) => e.status === 403);
    const { rowCount } = await db.query("delete from public.addons where group_id = $1", [id]);
    assert.equal(rowCount, 0, "RLS lets staff delete nothing");
  });
});

test("rules are checked in words: picks, names, prices", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.ownerA);
    const bad = async (input, pattern) => refused(() => admin.saveAddonGroup(db, shop, null, { ...EQUIPMENT, ...input }), (e) => e.status === 422 && pattern.test(e.message));
    await bad({ addons: [] }, /อย่างน้อย 1 รายการ/);
    await bad({ minSelect: 4 }, /ต้องเลือกอย่างน้อย 4 อย่าง แต่มีตัวเลือกที่เปิดอยู่ 3 อย่าง/);
    await bad({ minSelect: 2, maxSelect: 1 }, /เลือกได้สูงสุด/);
    await bad({ addons: [{ name: "ไม้" }, { name: "ไม้" }] }, /ซ้ำกัน/);
    await bad({ addons: [{ name: "ไม้", priceUnit: "per_week" }] }, /หน่วยราคา/);
    await bad({ addons: [{ name: "ไม้", amount: -1 }] }, /ไม่ติดลบ/);
    await bad({ addons: [{ name: "ไม้", addsMinutes: 1000 }] }, /เวลาที่เพิ่ม/);
  });
});

test("shop B cannot see, change or link into shop A's add-ons; anon reads nothing", { skip }, async () => {
  await inTx(async () => {
    const { id } = await admin.saveAddonGroup(db, await as(USERS.ownerA), null, EQUIPMENT);

    const b = await as(USERS.ownerB, "gentleman-barber");
    assert.deepEqual((await admin.getCatalog(db, b)).addonGroups, []);
    assert.equal((await db.query("select count(*)::int as n from public.addons")).rows[0].n, 0, "RLS hides A's add-ons");
    await refused(() => admin.saveAddonGroup(db, b, id, EQUIPMENT), (e) => e.status === 404);
    await refused(() => admin.saveAddonGroup(db, b, null, EQUIPMENT), (e) => e.status === 422, "A's offering cannot be linked from B");
    await refused(() => db.query("insert into public.addons (business_id, group_id, name) values ($1, $2, 'แอบใส่')", [SHOP_A, id]), (e) => e.status === 403);

    await db.query("reset role");
    await db.query("set local role anon");
    for (const table of ["addon_groups", "offering_addon_groups", "addons", "booking_addons"]) {
      await refused(() => db.query(`select * from public.${table}`), (e) => e.status === 403);
    }
  });
});

test("an add-on a booking took is switched off, not deleted; only the booking RPCs write booking_addons", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.ownerA);
    const { id } = await admin.saveAddonGroup(db, shop, null, EQUIPMENT);
    const [racket, shower, treatment] = (await admin.getCatalog(db, shop)).addonGroups[0].addons;
    const booking = await bookings.createBooking(db, shop, { offeringId: CUT, resourceId: NAN, date: bangkokDay(3), time: "11:00", customer: { name: "เช่าไม้" } });
    await refused(
      () => db.query("insert into public.booking_addons (business_id, booking_id, addon_id, name, total) values ($1, $2, $3, 'เช่าไม้', 50)", [SHOP_A, booking.id, racket.id]),
      (e) => e.status === 403
    );

    // what PR B's create_booking will do, as the database owner
    await db.query("reset role");
    await db.query("insert into public.booking_addons (business_id, booking_id, addon_id, quantity, name, total) values ($1, $2, $3, 2, 'เช่าไม้', 100)", [SHOP_A, booking.id, racket.id]);
    await as(USERS.ownerA);

    await admin.saveAddonGroup(db, shop, id, { ...EQUIPMENT, addons: [shower] });
    const left = (await admin.getCatalog(db, shop)).addonGroups[0].addons;
    assert.deepEqual(left.map((a) => [a.name, a.active]), [["ห้องอาบน้ำ", true], ["เช่าไม้", false]], "the taken one stays, switched off");
    assert.ok(!left.some((a) => a.id === treatment.id), "the untaken one is gone");

    assert.deepEqual(await admin.deleteAddonGroup(db, shop, id), { removed: false, archived: true });
    const { rows } = await db.query("select name, total::float8 as total from public.booking_addons where booking_id = $1", [booking.id]);
    assert.deepEqual(rows, [{ name: "เช่าไม้", total: 100 }], "the booking keeps what it took");

    const { id: unused } = await admin.saveAddonGroup(db, shop, null, { ...EQUIPMENT, name: "ไม่มีใครใช้" });
    assert.deepEqual(await admin.deleteAddonGroup(db, shop, unused), { removed: true, archived: false });
  });
});
