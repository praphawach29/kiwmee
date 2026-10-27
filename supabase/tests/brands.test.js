// Brands and branches (src/v2/admin-brands.js, migration …001100) against the test database, as a
// signed-in user exactly as app/api/dashboard/brands* does, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const brands = require("../../src/v2/admin-brands");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const BARBER = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber

const USERS = {
  owner: { id: "e6000000-0000-4000-8000-00000000000a", email: "brand-owner@test.local" },
  staff: { id: "e6000000-0000-4000-8000-00000000000b", email: "brand-staff@test.local" },
  other: { id: "e6000000-0000-4000-8000-00000000000c", email: "barber-owner@test.local" }
};

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

const brandOf = async (shopId) => (await db.query("select brand_id from public.businesses where id = $1", [shopId])).rows[0].brand_id;

// Owner of bloom-hair (shop and brand), a staff member there, and the barber's owner
async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SALON, BARBER, USERS.owner.id, USERS.staff.id, USERS.other.id]
    );
    await db.query("insert into public.brand_members (brand_id, user_id) values ($1, $2), ($3, $4)", [
      await brandOf(SALON),
      USERS.owner.id,
      await brandOf(BARBER),
      USERS.other.id
    ]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function as(user) {
  await db.query("reset role");
  await admin.actAs(db, user);
}

async function setPlan(shopId, plan, validUntil = null) {
  await db.query("reset role");
  await db.query("update public.brand_plans set plan = $2, valid_until = $3 where brand_id = $1", [await brandOf(shopId), plan, validUntil]);
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

const count = async (table, shopId) => Number((await db.query(`select count(*) from public.${table} where business_id = $1`, [shopId])).rows[0].count);
const shopId = async (slug) => (await db.query("select id from public.businesses where slug = $1", [slug])).rows[0].id;

test("every shop is a branch of a brand; a new shop starts its own brand on the free plan", { skip }, async () => {
  await inTx(async () => {
    const { rows } = await db.query("select count(*)::int as n from public.businesses where brand_id is null");
    assert.equal(rows[0].n, 0);
    assert.notEqual(await brandOf(SALON), await brandOf(BARBER));

    await as(USERS.owner);
    await admin.createShop(db, { name: "ร้านใหม่", slug: "new-shop", kind: "spa" });
    const list = await brands.listBrands(db);
    const mine = list.find((b) => b.name === "ร้านใหม่");
    assert.deepEqual([mine.plan, mine.owner, mine.branchLimit, mine.branchCount, mine.shops.map((s) => [s.slug, s.role])], ["free", true, 1, 1, [["new-shop", "owner"]]]);
    assert.ok(list.some((b) => b.shops.some((s) => s.slug === "bloom-hair")));
    assert.ok(!list.some((b) => b.shops.some((s) => s.slug === "gentleman-barber")), "another owner's brand stays hidden");
  });
});

test("a branch needs a plan with room for it, and is set up like the branch it copies", { skip }, async () => {
  await inTx(async () => {
    const brand = await brandOf(SALON);
    await as(USERS.owner);
    await refused(() => brands.addBranch(db, brand, { name: "Bloom สาขา 2", slug: "bloom-2", copyFrom: "bloom-hair" }), (e) => e.status === 422 && e.details.reason === "PLAN_LIMIT");

    await setPlan(SALON, "pro");
    await as(USERS.owner);
    assert.deepEqual(await brands.addBranch(db, brand, { name: "Bloom สาขา 2", slug: "bloom-2", copyFrom: "bloom-hair" }), { slug: "bloom-2" });
    const b2 = await shopId("bloom-2");
    assert.equal(await brandOf(b2), brand);
    assert.deepEqual([await count("offerings", b2), await count("price_rules", b2), await count("offering_requirements", b2)], [
      await count("offerings", SALON),
      await count("price_rules", SALON),
      await count("offering_requirements", SALON)
    ]);
    assert.deepEqual([await count("business_hours", b2), await count("booking_flows", b2), await count("business_booking_settings", b2)], [7, 1, 1]);
    assert.equal(await count("resources", b2), 0, "stylists are not copied unless asked");
    const shop = await admin.memberShop(db, "bloom-2", { owner: true });
    assert.equal(shop.role, "owner", "the brand owner owns the new branch");
    const settings = (await db.query("select min_lead_minutes, max_advance_days from public.business_booking_settings where business_id = $1", [b2])).rows[0];
    assert.deepEqual(settings, { min_lead_minutes: 30, max_advance_days: 30 });

    // with the stylists: same people, same weekly schedule, same "who does what"
    await brands.addBranch(db, brand, { name: "Bloom สาขา 3", slug: "bloom-3", copyFrom: "bloom-hair", copyResources: true });
    const b3 = await shopId("bloom-3");
    assert.deepEqual([await count("resources", b3), await count("resource_schedules", b3), await count("offering_resources", b3)], [
      await count("resources", SALON),
      await count("resource_schedules", SALON),
      await count("offering_resources", SALON)
    ]);
    const colourOnly = (
      await db.query(
        `select o.name from public.offering_resources l join public.resources r on r.id = l.resource_id join public.offerings o on o.id = l.offering_id
          where l.business_id = $1 and r.name like 'ช่างพลอย%'`,
        [b3]
      )
    ).rows.map((r) => r.name);
    assert.deepEqual(colourOnly, ["ทำสีผม"]);

    // a blank branch, and a link that is taken
    await brands.addBranch(db, brand, { name: "สาขาว่าง", slug: "bloom-blank" });
    assert.equal(await count("offerings", await shopId("bloom-blank")), 0);
    await refused(() => brands.addBranch(db, brand, { name: "ซ้ำ", slug: "gentleman-barber" }), (e) => e.code === "23505");
    await refused(() => brands.addBranch(db, brand, { name: "x", slug: "Bad Slug" }), (e) => e.status === 422);
    await refused(() => brands.addBranch(db, brand, { name: "x", slug: "bloom-x", copyFrom: "gentleman-barber" }), (e) => e.status === 404);
  });
});

test("an expired plan is the free plan again", { skip }, async () => {
  await inTx(async () => {
    await setPlan(SALON, "pro", new Date(Date.now() - 86400000).toISOString());
    await as(USERS.owner);
    const brand = await brandOf(SALON);
    assert.equal((await brands.listBrands(db)).find((b) => b.id === brand).plan, "free");
    await refused(() => brands.addBranch(db, brand, { name: "x", slug: "bloom-x" }), (e) => e.details.reason === "PLAN_LIMIT");
  });
});

test("shops opened separately can be brought into one brand", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.owner);
    await admin.createShop(db, { name: "Bloom สาขาเก่า", slug: "bloom-old" });
    const old = await shopId("bloom-old");
    const oldBrand = await brandOf(old);
    const brand = await brandOf(SALON);

    await refused(() => brands.moveShop(db, brand, { slug: "bloom-old" }), (e) => e.details.reason === "PLAN_LIMIT");
    await setPlan(SALON, "pro");
    await as(USERS.owner);
    await brands.moveShop(db, brand, { slug: "bloom-old" });
    assert.equal(await brandOf(old), brand);
    assert.equal((await db.query("select count(*)::int as n from public.brands where id = $1", [oldBrand])).rows[0].n, 0, "the empty brand is gone");
    const shops = (await brands.listBrands(db)).find((b) => b.id === brand).shops.map((s) => s.slug).sort();
    assert.deepEqual(shops, ["bloom-hair", "bloom-old"]);
    await refused(() => brands.moveShop(db, brand, { slug: "bloom-old" }), (e) => e.details.reason === "SAME_BRAND");
    // someone else's shop cannot be pulled in (it is not even visible), nor can staff pull one in
    await refused(() => brands.moveShop(db, brand, { slug: "gentleman-barber" }), (e) => e.status === 404);
    await refused(() => db.query("select public.move_business_to_brand($1, $2)", [BARBER, brand]), (e) => e.code === "BK422" && e.message === "NOT_OWNER");
  });
});

test("staff see the brand but cannot change it; nobody changes brands around the RPCs", { skip }, async () => {
  await inTx(async () => {
    const brand = await brandOf(SALON);
    const barberBrand = await brandOf(BARBER);
    await setPlan(SALON, "pro");
    await as(USERS.staff);
    const seen = (await brands.listBrands(db)).find((b) => b.id === brand);
    assert.deepEqual([seen.owner, seen.shops.map((s) => s.role)], [false, ["staff"]]);
    await refused(() => brands.addBranch(db, brand, { name: "x", slug: "bloom-x" }), (e) => e.status === 403);
    await refused(() => brands.renameBrand(db, brand, { name: "ชื่อใหม่" }), (e) => e.status === 404);

    await as(USERS.owner);
    await brands.renameBrand(db, brand, { name: "Bloom Group" });
    assert.equal((await brands.listBrands(db)).find((b) => b.id === brand).name, "Bloom Group");
    // a shop owner cannot move the shop by editing it, nor change the plan
    await refused(() => db.query("update public.businesses set brand_id = $2 where id = $1", [SALON, barberBrand]), (e) => e.code === "42501");
    await refused(() => db.query("update public.brand_plans set plan = 'loyalty'"), (e) => e.code === "42501");
    await refused(() => db.query("insert into public.brand_members (brand_id, user_id) values ($1, $2)", [brand, USERS.staff.id]), (e) => e.code === "42501");

    await as(USERS.other);
    await refused(() => brands.renameBrand(db, brand, { name: "ยึด" }), (e) => e.status === 404);
    await refused(() => brands.addBranch(db, brand, { name: "x", slug: "bloom-x" }), (e) => e.status === 403);

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.brands"), (e) => e.code === "42501");
    await refused(() => db.query(`select public.add_branch('${brand}', 'x', 'bloom-x')`), (e) => e.code === "42501");
  });
});
