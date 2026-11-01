const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { actAs } = require('../../src/v2/admin-catalog');
const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && 'set SUPABASE_TEST_DB_URL for local Storage policy tests';
const SHOP = 'b1000000-0000-4000-8000-000000000001';
const OTHER = 'b2000000-0000-4000-8000-000000000002';
const OWNER = { id: 'ef000000-0000-4000-8000-000000000001' };
const STAFF = { id: 'ef000000-0000-4000-8000-000000000002' };
const object = `${SHOP}/12345678-1234-4234-8234-123456789012.webp`;
let db;
test.before(async () => { if (!skip) { db = new Client({ connectionString: url }); await db.connect(); } });
test.after(async () => db && db.end());
async function transaction(fn) {
  await db.query('begin');
  try { await fn(); } finally { await db.query('rollback'); }
}
async function denied(sql, args, code = '42501') {
  await db.query('savepoint denied');
  await assert.rejects(db.query(sql, args), e => e.code === code);
  await db.query('rollback to savepoint denied');
}
const insert = 'insert into storage.objects(bucket_id,name) values ($1,$2)';

test('bucket is public with 5MiB and raster-only MIME limits', { skip }, async () => {
  const { rows: [bucket] } = await db.query("select * from storage.buckets where id = 'shop-media'");
  assert.equal(bucket.public, true);
  assert.equal(Number(bucket.file_size_limit), 5242880);
  assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg','image/png','image/webp']);
});

test('Storage RLS allows own insert/public read; denies staff, cross-tenant, malformed names and overwrite', { skip }, async () => transaction(async () => {
  await db.query('insert into auth.users(id) values ($1),($2)', [OWNER.id, STAFF.id]);
  await db.query("insert into public.business_members(business_id,user_id,role) values ($1,$2,'owner'),($1,$3,'staff')", [SHOP, OWNER.id, STAFF.id]);
  // Simulate pre-existing broad project policies; restrictive guards must still isolate this bucket.
  await db.query("create policy test_broad_storage on storage.objects for all to anon, authenticated using (true) with check (true)");
  await actAs(db, OWNER);
  await db.query(insert, ['shop-media', object]);
  await denied(insert, ['shop-media', object], '23505');
  for (const name of [object.replace(SHOP, OTHER), 'garbage/image.webp', `${SHOP}/../../x.webp`, `${SHOP}/file.svg`, `${SHOP}/file.webp`, `${object}/extra`]) {
    await denied(insert, ['shop-media', name]);
  }
  assert.equal((await db.query("update storage.objects set name = $1 where bucket_id = 'shop-media'", [object.replace('.webp','.png')])).rowCount, 0);
  assert.equal((await db.query("delete from storage.objects where bucket_id = 'shop-media'")).rowCount, 0);
  await actAs(db, STAFF);
  await denied(insert, ['shop-media', object.replace('.webp','.png')]);
  await db.query('set local role anon');
  await db.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '{}', true)");
  await denied(insert, ['shop-media', object.replace('.webp','.jpg')]);
  assert.equal((await db.query("select name from storage.objects where bucket_id = 'shop-media'")).rows[0].name, object);
  await db.query('reset role');
  await db.query("insert into storage.buckets(id,name) values ('another','another')");
  await actAs(db, OWNER);
  await db.query(insert, ['another', 'unrelated.txt']);
  assert.equal((await db.query("delete from storage.objects where bucket_id = 'another'")).rowCount, 1);
}));
