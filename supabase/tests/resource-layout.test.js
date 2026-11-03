// แผนผังสนาม (migration …002900) against the test database: the owner places courts on the map,
// overlaps and off-grid spots are refused, staff cannot change it, the customer page gets the spots,
// and the database itself refuses a spot off the 12 × 12 grid.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { shopInfo } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";
const SHOP = "b1000000-0000-4000-8000-000000000001";
const OTHER = "b2000000-0000-4000-8000-000000000002";
const OWNER = { id: "ef290000-0000-4000-8000-000000000001" };
const STAFF = { id: "ef290000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ef290000-0000-4000-8000-000000000003" };

let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try { await assert.rejects(fn, check); } finally { await db.query("rollback to savepoint expect_error"); }
}

test("map: owner places, overlaps refused, staff and other shops cannot, customers see it", { skip }, async () => {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [OWNER.id, STAFF.id, RIVAL.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')", [SHOP, OTHER, OWNER.id, STAFF.id, RIVAL.id]);
    await admin.actAs(db, OWNER);
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const [a, b, c] = (await admin.getCatalog(db, shop)).resources.filter((r) => r.active);
    assert.equal(a.layout, null);

    await admin.saveLayout(db, shop, [{ id: a.id, layout: { row: 1, col: 1, w: 2, h: 1 } }, { id: b.id, layout: { row: 1, col: 3 } }]);
    let catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.resources.find((r) => r.id === a.id).layout, { row: 1, col: 1, w: 2, h: 1 });
    assert.deepEqual(catalog.resources.find((r) => r.id === b.id).layout, { row: 1, col: 3, w: 1, h: 1 });

    // c onto a's second cell: refused, nothing changes; off the grid: refused
    await refused(() => admin.saveLayout(db, shop, [{ id: c.id, layout: { row: 1, col: 2 } }]), /ทับกันในผัง/);
    await refused(() => admin.saveLayout(db, shop, [{ id: c.id, layout: { row: 1, col: 12, w: 2 } }]), /12 × 12/);
    // moving a out of the way in the same save lets c in
    await admin.saveLayout(db, shop, [{ id: a.id, layout: { row: 2, col: 1, w: 2, h: 1 } }, { id: c.id, layout: { row: 1, col: 2 } }]);

    // the customer page: the spot comes with each pickable resource that has one
    await db.query("reset role");
    const info = await shopInfo(db, "bloom-hair");
    const placed = info.resources.filter((r) => r.layout);
    assert.ok(placed.length >= 1);
    assert.deepEqual(Object.keys(placed[0].layout).sort(), ["col", "h", "row", "w"]);

    // staff: no (owner only); another shop's owner: not their resources
    await admin.actAs(db, STAFF);
    await refused(() => admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
    await db.query("reset role");
    await admin.actAs(db, RIVAL);
    const rival = await admin.memberShop(db, "gentleman-barber", { owner: true });
    await refused(() => admin.saveLayout(db, rival, [{ id: a.id, layout: null }]), /ไม่พบ/);
    await db.query("reset role");

    // the database refuses a spot off the grid or half-set
    await refused(() => db.query("update public.resources set layout_row = 12, layout_col = 1, layout_h = 2 where id = $1", [a.id]), (e) => e.code === "23514");
    await refused(() => db.query("update public.resources set layout_row = 3, layout_col = null where id = $1", [a.id]), (e) => e.code === "23514");

    // taking it off the map
    await admin.actAs(db, OWNER);
    await admin.saveLayout(db, shop, [{ id: a.id, layout: null }]);
    catalog = await admin.getCatalog(db, shop);
    assert.equal(catalog.resources.find((r) => r.id === a.id).layout, null);
  } finally {
    await db.query("rollback");
  }
});
