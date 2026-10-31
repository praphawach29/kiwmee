const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { shopInfo } = require("../../src/v2/public-booking");
const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL for local database tests";
const SHOP = "b1000000-0000-4000-8000-000000000001";
const OTHER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001";
const OWNER = { id: "ef000000-0000-4000-8000-000000000001" };
const STAFF = { id: "ef000000-0000-4000-8000-000000000002" };
const gallery = [{ url: "/demo-media/jackshop/court.webp", alt: "สนามกีฬา" }, { url: "https://example.com/image.jpg", alt: "" }];
let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());
async function transaction(fn) {
  await db.query("begin");
  try { await fn(); } finally { await db.query("rollback"); }
}
async function members() {
  await db.query("insert into auth.users (id) values ($1), ($2)", [OWNER.id, STAFF.id]);
  await db.query("insert into public.business_members (business_id,user_id,role) values ($1,$2,'owner'),($1,$3,'staff')", [SHOP, OWNER.id, STAFF.id]);
}
async function rejectsSql(sql, values, code = "23514") {
  await db.query("savepoint rejection");
  await assert.rejects(db.query(sql, values), (e) => e.code === code);
  await db.query("rollback to savepoint rejection");
}

test("media defaults and owner roundtrip preserve omitted galleries, clear explicitly, and reach public shopInfo", { skip }, async () => transaction(async () => {
  await members();
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  let catalog = await admin.getCatalog(db, shop);
  assert.deepEqual(catalog.shop.media, []);
  assert.deepEqual(catalog.offerings.find((o) => o.id === CUT).media, []);
  await admin.saveShop(db, shop, { name: shop.name, media: gallery });
  await admin.saveOffering(db, shop, CUT, { name: "Sport", durationMinutes: 30, media: gallery });
  await admin.saveShop(db, shop, { name: shop.name });
  await admin.saveOffering(db, shop, CUT, { name: "Sport", durationMinutes: 30 });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual(catalog.shop.media, gallery);
  assert.deepEqual(catalog.offerings.find((o) => o.id === CUT).media, gallery);
  const created = await admin.saveOffering(db, shop, null, { name: "New", durationMinutes: 30 });
  assert.deepEqual((await admin.getCatalog(db, shop)).offerings.find((o) => o.id === created.id).media, []);
  await db.query("reset role"); // public API uses its existing server-side DB connection, not anon grants
  const info = await shopInfo(db, "bloom-hair");
  assert.deepEqual(info.media, gallery);
  assert.deepEqual(info.offerings.find((o) => o.id === CUT).media, gallery);
  await admin.actAs(db, OWNER);
  await admin.saveShop(db, shop, { name: shop.name, media: [] });
  await admin.saveOffering(db, shop, CUT, { name: "Sport", durationMinutes: 30, media: [] });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual(catalog.shop.media, []);
  assert.deepEqual(catalog.offerings.find((o) => o.id === CUT).media, []);
}));

test("DB constraints reject invalid media on both tables even when bypassing application validation", { skip }, async () => transaction(async () => {
  const invalid = [null, {}, [null], [{ url: "http://example.com/a", alt: "" }], [{ url: "data:image/png,abc", alt: "" }], [{ url: "javascript:alert(1)", alt: "" }], [{ url: "//example.com/a", alt: "" }], [{ url: "https://u:p@example.com/a", alt: "" }], [{ url: "https://@example.com/a", alt: "" }], [{ url: "/demo-media/../a", alt: "" }], [{ url: "/demo-media/%2e%2e/a", alt: "" }], [{ url: "https://example.com/\na", alt: "" }], [{ url: "https://example.com/a", alt: "a".repeat(201) }], [{ url: "https://example.com/" + "a".repeat(2048), alt: "" }], [{ url: gallery[0].url }], [{ ...gallery[0], extra: 1 }], Array(9).fill(gallery[0])];
  for (const table of ["businesses", "offerings"]) {
    const id = table === "businesses" ? SHOP : CUT;
    for (const media of invalid) await rejectsSql(`update public.${table} set media = $2::jsonb where id = $1`, [id, JSON.stringify(media)]);
    await rejectsSql(`update public.${table} set media = null where id = $1`, [id], "23502");
    await db.query(`update public.${table} set media = $2::jsonb where id = $1`, [id, JSON.stringify(Array(8).fill(gallery[0]))]);
  }
}));

test("media inherits existing owner writes, member reads, tenant isolation, and anon denial", { skip }, async () => transaction(async () => {
  await members();
  await admin.actAs(db, STAFF);
  assert.equal((await db.query("update public.businesses set media = $2::jsonb where id = $1", [SHOP, JSON.stringify(gallery)])).rowCount, 0);
  assert.equal((await db.query("update public.offerings set media = $2::jsonb where id = $1", [CUT, JSON.stringify(gallery)])).rowCount, 0);
  assert.deepEqual((await db.query("select media from public.businesses where id = $1", [SHOP])).rows[0].media, []);
  await assert.rejects(admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
  await admin.actAs(db, OWNER);
  assert.equal((await db.query("update public.businesses set media = $2::jsonb where id = $1", [OTHER, JSON.stringify(gallery)])).rowCount, 0);
  assert.equal((await db.query("select media from public.offerings where business_id = $1", [OTHER])).rowCount, 0);
  await db.query("set local role anon");
  await rejectsSql("select media from public.businesses", [], "42501");
  await rejectsSql("select media from public.offerings", [], "42501");
}));
