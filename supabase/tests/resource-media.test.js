const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const brands = require("../../src/v2/admin-brands");
const { shopInfo } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL for local database tests";
const SHOP = "b1000000-0000-4000-8000-000000000001";
const OTHER = "b2000000-0000-4000-8000-000000000002";
const OWNER = { id: "ef160000-0000-4000-8000-000000000001" };
const STAFF = { id: "ef160000-0000-4000-8000-000000000002" };
const gallery = [{ url: "/demo-media/jackshop/court.webp", alt: "สนามกีฬา" }, { url: "https://example.com/image.jpg", alt: "" }];
let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());
async function transaction(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2)", [OWNER.id, STAFF.id]);
    await db.query("insert into public.business_members (business_id,user_id,role) values ($1,$2,'owner'),($1,$3,'staff')", [SHOP, OWNER.id, STAFF.id]);
    await fn();
  } finally { await db.query("rollback"); }
}
async function rejectsSql(sql, values, code) {
  await db.query("savepoint rejection");
  await assert.rejects(db.query(sql, values), (e) => e.code === code);
  await db.query("rollback to savepoint rejection");
}

test("resource media defaults, owner roundtrip, omitted preservation, public gallery and explicit clear", { skip }, async () => transaction(async () => {
  await admin.actAs(db, OWNER);
  const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
  let catalog = await admin.getCatalog(db, shop);
  const resource = catalog.resources[0];
  assert.deepEqual(resource.media, []);
  const input = { kind: resource.kind, name: resource.name };
  await admin.saveResource(db, shop, resource.id, { ...input, media: gallery });
  await admin.saveResource(db, shop, resource.id, input);
  assert.deepEqual((await admin.getCatalog(db, shop)).resources.find((r) => r.id === resource.id).media, gallery);
  const created = await admin.saveResource(db, shop, null, { kind: "court", name: "New gallery", media: gallery });
  const empty = await admin.saveResource(db, shop, null, { kind: "court", name: "Empty gallery" });
  catalog = await admin.getCatalog(db, shop);
  assert.deepEqual(catalog.resources.find((r) => r.id === created.id).media, gallery);
  assert.deepEqual(catalog.resources.find((r) => r.id === empty.id).media, []);
  await db.query("reset role");
  const info = await shopInfo(db, "bloom-hair");
  assert.deepEqual(info.resources.find((r) => r.id === resource.id).media, gallery);
  assert.ok(!info.resources.some((r) => r.id === created.id), "unlinked resources stay hidden");
  await db.query("update public.resources set active = false where id = $1", [resource.id]);
  assert.ok(!(await shopInfo(db, "bloom-hair")).resources.some((r) => r.id === resource.id), "inactive resources stay hidden");
  await admin.actAs(db, OWNER);
  await admin.saveResource(db, shop, resource.id, { ...input, media: [] });
  assert.deepEqual((await admin.getCatalog(db, shop)).resources.find((r) => r.id === resource.id).media, []);
}));

test("resource media DB constraint rejects malformed references and null", { skip }, async () => transaction(async () => {
  const id = (await db.query("select id from public.resources where business_id = $1 limit 1", [SHOP])).rows[0].id;
  for (const media of [null, {}, [null], [{ url: "http://example.com/a", alt: "" }], [{ url: "javascript:alert(1)", alt: "" }], [{ url: "/demo-media/../a", alt: "" }], [{ url: gallery[0].url }], [{ ...gallery[0], extra: true }], [{ url: gallery[0].url, alt: "a".repeat(201) }], Array(9).fill(gallery[0])]) {
    await rejectsSql("update public.resources set media = $2::jsonb where id = $1", [id, JSON.stringify(media)], "23514");
  }
  await rejectsSql("update public.resources set media = null where id = $1", [id], "23502");
  await db.query("update public.resources set media = $2::jsonb where id = $1", [id, JSON.stringify(Array(8).fill(gallery[0]))]);
}));

test("resource gallery inherits business_members owner writes, staff reads, tenant and anon denial", { skip }, async () => transaction(async () => {
  const resource = (await db.query("select id from public.resources where business_id = $1 limit 1", [SHOP])).rows[0];
  const otherResource = (await db.query("select id from public.resources where business_id = $1 limit 1", [OTHER])).rows[0];
  await admin.actAs(db, STAFF);
  assert.deepEqual((await db.query("select media from public.resources where id = $1", [resource.id])).rows[0].media, []);
  assert.equal((await db.query("update public.resources set media = $2::jsonb where id = $1", [resource.id, JSON.stringify(gallery)])).rowCount, 0);
  await assert.rejects(admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
  await rejectsSql("insert into public.resources (business_id,kind,name,media) values ($1,'court','Denied',$2::jsonb)", [SHOP, JSON.stringify(gallery)], "42501");
  await admin.actAs(db, OWNER);
  assert.equal((await db.query("select media from public.resources where business_id = $1", [OTHER])).rowCount, 0);
  assert.equal((await db.query("update public.resources set media = $2::jsonb where id = $1", [otherResource.id, JSON.stringify(gallery)])).rowCount, 0);
  await assert.rejects(admin.memberShop(db, "gentleman-barber", { owner: true }), (e) => e.status === 404);
  await rejectsSql("insert into public.resources (business_id,kind,name,media) values ($1,'court','Denied',$2::jsonb)", [OTHER, JSON.stringify(gallery)], "42501");
  await db.query("set local role anon");
  await rejectsSql("select media from public.resources", [], "42501");
}));

test("add_branch copies active resource galleries only when copyResources is enabled", { skip }, async () => transaction(async () => {
  const brand = (await db.query("select brand_id from public.businesses where id = $1", [SHOP])).rows[0].brand_id;
  await db.query("insert into public.brand_members (brand_id,user_id) values ($1,$2)", [brand, OWNER.id]);
  await db.query("update public.brand_plans set plan = 'pro' where brand_id = $1", [brand]);
  await db.query("update public.resources set media = $2::jsonb where business_id = $1", [SHOP, JSON.stringify(gallery)]);
  await db.query("insert into public.resources (business_id,kind,name,active,media) values ($1,'court','Inactive gallery',false,$2::jsonb)", [SHOP, JSON.stringify(gallery)]);
  await admin.actAs(db, OWNER);
  await brands.addBranch(db, brand, { name: "Gallery copy", slug: "resource-gallery-copy", copyFrom: "bloom-hair", copyResources: true });
  const copied = await admin.getCatalog(db, await admin.memberShop(db, "resource-gallery-copy"));
  assert.ok(copied.resources.length > 0);
  assert.ok(!copied.resources.some((r) => r.name === "Inactive gallery"));
  for (const resource of copied.resources) assert.deepEqual(resource.media, gallery);
  await brands.addBranch(db, brand, { name: "No resources", slug: "resource-gallery-no-copy", copyFrom: "bloom-hair" });
  assert.deepEqual((await admin.getCatalog(db, await admin.memberShop(db, "resource-gallery-no-copy"))).resources, []);
}));
