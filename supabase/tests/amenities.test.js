// Shop amenities + "about" (migration …002400) against the test database: the owner saves them,
// the customer page reads them, unknown codes are refused by the app and by the database, and only
// the shop's own owner can change them. Rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { shopInfo } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL for local database tests";
const SHOP = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const OTHER = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const OWNER = { id: "ea000000-0000-4000-8000-000000000001" };
const STAFF = { id: "ea000000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ea000000-0000-4000-8000-000000000003" };

let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());

async function transaction(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [OWNER.id, STAFF.id, RIVAL.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SHOP, OTHER, OWNER.id, STAFF.id, RIVAL.id]);
    await fn();
  } finally {
    await db.query("rollback");
  }
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("the owner saves amenities and an about text; kept when omitted, cleared when empty; the customer page shows them", { skip }, async () => transaction(async () => {
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  let catalog = await admin.getCatalog(db, shop);
  assert.deepEqual([catalog.shop.amenities, catalog.shop.about], [[], ""]);

  // listed in any order, saved once each in the list's order
  await admin.saveShop(db, shop, { name: shop.name, amenities: ["wifi", "parking", "wifi", "lights"], about: "  สนามมาตรฐาน\nเปิดถึงเที่ยงคืน  " });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual(catalog.shop.amenities, ["parking", "lights", "wifi"]);
  assert.equal(catalog.shop.about, "สนามมาตรฐาน\nเปิดถึงเที่ยงคืน");

  await admin.saveShop(db, shop, { name: shop.name }); // omitted: unchanged
  assert.deepEqual((await admin.getCatalog(db, shop)).shop.amenities, ["parking", "lights", "wifi"]);

  await db.query("reset role"); // the customer page reads through the server's connection
  const info = await shopInfo(db, "bloom-hair");
  assert.deepEqual([info.amenities, info.about], [["parking", "lights", "wifi"], "สนามมาตรฐาน\nเปิดถึงเที่ยงคืน"]);

  await admin.actAs(db, OWNER);
  await admin.saveShop(db, shop, { name: shop.name, amenities: [], about: "" });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual([catalog.shop.amenities, catalog.shop.about], [[], ""]);
  assert.equal((await db.query("select about from public.businesses where id = $1", [SHOP])).rows[0].about, null);
}));

test("unknown amenities and a too-long about are refused, by the app and by the database", { skip }, async () => transaction(async () => {
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  await refused(() => admin.saveShop(db, shop, { name: shop.name, amenities: ["parking", "helipad"] }), (e) => e.status === 422);
  await refused(() => admin.saveShop(db, shop, { name: shop.name, amenities: "parking" }), (e) => e.status === 422);
  await refused(() => admin.saveShop(db, shop, { name: shop.name, about: "ก".repeat(1001) }), (e) => e.status === 422);

  await db.query("reset role");
  await refused(() => db.query("update public.businesses set amenities = '{helipad}' where id = $1", [SHOP]), (e) => e.code === "23514");
  await refused(() => db.query("update public.businesses set about = $2 where id = $1", [SHOP, "ก".repeat(1001)]), (e) => e.code === "23514");
}));

test("only the shop's own owner changes them: not staff, not another shop's owner, not anon", { skip }, async () => transaction(async () => {
  await admin.actAs(db, STAFF);
  await refused(() => admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
  // straight at the table: RLS lets the row through for owners only
  const staff = await db.query("update public.businesses set amenities = '{parking}' where id = $1", [SHOP]);
  assert.equal(staff.rowCount, 0);

  await admin.actAs(db, RIVAL);
  const rival = await db.query("update public.businesses set amenities = '{parking}', about = 'x' where id = $1", [SHOP]);
  assert.equal(rival.rowCount, 0);
  assert.equal((await db.query("select count(*)::int as n from public.businesses where id = $1", [SHOP])).rows[0].n, 0, "another shop's owner cannot even read it");

  await db.query("reset role");
  await db.query("set local role anon");
  await refused(() => db.query("select amenities, about from public.businesses"), (e) => e.code === "42501");
  await db.query("reset role");
  assert.deepEqual((await db.query("select amenities, about from public.businesses where id = $1", [SHOP])).rows[0], { amenities: [], about: null });
}));
