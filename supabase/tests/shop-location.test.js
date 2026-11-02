// Shop address + map link (migration …002500) against the test database: the owner saves them, the
// customer pages get a "นำทาง" link, only map sites are accepted (app and database), and only the
// shop's own owner changes them. Rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { shopInfo, book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL for local database tests";
const SHOP = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const OTHER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const OWNER = { id: "eb000000-0000-4000-8000-000000000001" };
const STAFF = { id: "eb000000-0000-4000-8000-000000000002" };
const RIVAL = { id: "eb000000-0000-4000-8000-000000000003" };
const MAP = "https://maps.app.goo.gl/AbC123";

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

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("the owner saves the address and map link; customer pages get the way there", { skip }, async () => transaction(async () => {
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  let catalog = await admin.getCatalog(db, shop);
  assert.deepEqual([catalog.shop.address, catalog.shop.mapUrl], ["", ""]);

  await admin.saveShop(db, shop, { name: shop.name, address: "  99/9 ซ.สุขุมวิท 77\n  กรุงเทพฯ ", mapUrl: MAP });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual([catalog.shop.address, catalog.shop.mapUrl], ["99/9 ซ.สุขุมวิท 77 กรุงเทพฯ", MAP]);
  await admin.saveShop(db, shop, { name: shop.name }); // omitted: kept
  assert.equal((await admin.getCatalog(db, shop)).shop.mapUrl, MAP);

  await db.query("reset role");
  const info = await shopInfo(db, "bloom-hair");
  assert.deepEqual([info.address, info.directions], ["99/9 ซ.สุขุมวิท 77 กรุงเทพฯ", MAP]);
  const made = await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: bangkokTuesday(3), time: "11:00" }, customer: { name: "ลูกค้า", phone: "0812345678" } });
  assert.equal((await manage.findManaged(db, "bloom-hair", made.manageToken)).shop.directions, MAP);

  // no map link: search the address
  await admin.actAs(db, OWNER);
  await admin.saveShop(db, shop, { name: shop.name, mapUrl: "" });
  await db.query("reset role");
  assert.match((await shopInfo(db, "bloom-hair")).directions, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  // neither: no button
  await admin.actAs(db, OWNER);
  await admin.saveShop(db, shop, { name: shop.name, address: "" });
  await db.query("reset role");
  assert.equal((await shopInfo(db, "bloom-hair")).directions, null);
}));

test("only map links over https; the database refuses the rest too", { skip }, async () => transaction(async () => {
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  for (const bad of ["https://evil.example/x", "http://maps.app.goo.gl/x", "javascript:alert(1)"]) {
    await refused(() => admin.saveShop(db, shop, { name: shop.name, mapUrl: bad }), (e) => e.status === 422);
  }
  await refused(() => admin.saveShop(db, shop, { name: shop.name, address: "ก".repeat(301) }), (e) => e.status === 422);
  await db.query("reset role");
  await refused(() => db.query("update public.businesses set map_url = 'http://x' where id = $1", [SHOP]), (e) => e.code === "23514");
  await refused(() => db.query("update public.businesses set address = $2 where id = $1", [SHOP, "ก".repeat(301)]), (e) => e.code === "23514");
}));

test("only the shop's own owner changes them: not staff, not another shop's owner, not anon", { skip }, async () => transaction(async () => {
  await admin.actAs(db, STAFF);
  assert.equal((await db.query("update public.businesses set address = 'x' where id = $1", [SHOP])).rowCount, 0);
  await admin.actAs(db, RIVAL);
  assert.equal((await db.query("update public.businesses set map_url = $2 where id = $1", [SHOP, MAP])).rowCount, 0);
  await db.query("reset role");
  await db.query("set local role anon");
  await refused(() => db.query("select address, map_url from public.businesses"), (e) => e.code === "42501");
  await db.query("reset role");
  assert.deepEqual((await db.query("select address, map_url from public.businesses where id = $1", [SHOP])).rows[0], { address: null, map_url: null });
}));
