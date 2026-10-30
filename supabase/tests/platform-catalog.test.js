const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { asUser } = require('../../src/v2/admin-catalog');
const { listCatalog } = require('../../src/v2/platform-catalog');
const url = process.env.SUPABASE_TEST_DB_URL;
test('real database: root reads catalog across brands; ordinary user is refused', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  const root = { id: 'e8000000-0000-4000-8000-00000000000a', email: 'catalog-root@test.local' };
  const owner = { id: 'e8000000-0000-4000-8000-00000000000b', email: 'catalog-owner@test.local' };
  try {
    await pool.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [root.id,root.email,owner.id,owner.email]);
    await pool.query('insert into public.platform_admins(user_id) values ($1)', [root.id]);
    const result = await asUser(pool, root, client => listCatalog(client, { poolFactory: () => pool }));
    const brands = await pool.query('select count(*)::int as n from public.brands');
    const shops = await pool.query('select count(*)::int as n from public.businesses');
    assert.equal(result.brands.length, brands.rows[0].n);
    assert.equal(result.shops.length, shops.rows[0].n);
    assert.ok(result.brands.length > 1);
    await assert.rejects(asUser(pool, owner, client => listCatalog(client, { poolFactory: () => { throw Error('owner reads must not run'); } })), e => e.code === 'FORBIDDEN');
  } finally {
    await pool.query('delete from auth.users where id = any($1::uuid[])', [[root.id,owner.id]]);
    await pool.end();
  }
});
