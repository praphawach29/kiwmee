// Platform-wide catalog (brands + shops) for /super. Read-only.
// The pool connects as the DB owner, so RLS does not apply; we check platform admin as the user first.

const { getBookingPool } = require("./db");
const { forbidden } = require("../errors");

async function requirePlatformAdmin(client) {
  const { rows } = await client.query("select public.is_platform_admin() as admin");
  if (rows[0].admin !== true) {
    throw forbidden("เฉพาะผู้ดูแลแพลตฟอร์มเท่านั้น");
  }
}

async function listAllBrands(pool) {
  const { rows } = await pool.query(`
    select br.id, br.name, public.brand_plan(br.id) as plan,
           public.brand_branch_limit(public.brand_plan(br.id)) as branch_limit,
           (select count(*)::int from public.businesses x where x.brand_id = br.id) as branch_count,
           coalesce((select u.email from public.brand_members bm join auth.users u on u.id = bm.user_id where bm.brand_id = br.id order by bm.user_id limit 1), null) as owner_email
      from public.brands br
     order by br.name
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    plan: r.plan,
    branchLimit: r.branch_limit,
    branchCount: r.branch_count,
    ownerEmail: r.owner_email,
  }));
}

async function listAllShops(pool) {
  const { rows } = await pool.query(`
    select b.id, b.slug, b.name, b.kind, br.name as brand_name, br.id as brand_id
      from public.businesses b
      left join public.brands br on br.id = b.brand_id
     order by b.name
  `);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    brandName: r.brand_name,
    brandId: r.brand_id,
  }));
}

async function listCatalog(client, { poolFactory = getBookingPool } = {}) {
  await requirePlatformAdmin(client);
  const pool = poolFactory();
  // Sequential reads keep one connection available for the user transaction (pool max=3).
  const brands = await listAllBrands(pool);
  const shops = await listAllShops(pool);
  return { brands, shops };
}
module.exports = { listCatalog };
