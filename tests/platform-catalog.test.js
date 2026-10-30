const test = require('node:test');
const assert = require('node:assert/strict');
const { listCatalog } = require('../src/v2/platform-catalog');
const user = (admin) => ({ query: async () => ({ rows: [{ admin }] }) });

test('catalog denies non-admin before acquiring the cross-tenant pool', async () => {
  let acquired = false;
  await assert.rejects(listCatalog(user(false), { poolFactory: () => { acquired = true; } }),
    e => e.code === 'FORBIDDEN' && e.status === 403);
  assert.equal(acquired, false);
});

test('catalog auth failure cannot reach owner reads', async () => {
  let acquired = false;
  await assert.rejects(listCatalog({ query: async () => { throw Error('database unavailable'); } },
    { poolFactory: () => { acquired = true; } }));
  assert.equal(acquired, false);
});

test('catalog maps real brand/shop rows without exposing extra database fields', async () => {
  const pool = { query: async sql => ({ rows: /from public.brands br/.test(sql) ?
    [{ id: 'brand', name: 'Brand', plan: 'pro', branch_limit: 50, branch_count: 2, owner_email: 'owner@example.test', private: 'hidden' }] :
    [{ id: 'shop', name: 'Shop', slug: 'shop', kind: 'salon', brand_name: 'Brand', brand_id: 'brand' }] }) };
  const result = await listCatalog(user(true), { poolFactory: () => pool });
  assert.deepEqual(result.brands, [{ id: 'brand', name: 'Brand', plan: 'pro', branchLimit: 50, branchCount: 2, ownerEmail: 'owner@example.test' }]);
  assert.deepEqual(result.shops, [{ id: 'shop', name: 'Shop', slug: 'shop', kind: 'salon', brandName: 'Brand', brandId: 'brand' }]);
});

test('catalog route loads and rejects anonymous requests', async () => {
  const { GET } = require('../app/api/super/catalog/route');
  const response = await GET(new Request('http://localhost/api/super/catalog'));
  assert.equal(response.status, 401);
});
