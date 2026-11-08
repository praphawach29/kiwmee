// Wallet (migration …003700): the ledger, the two money functions, the usage counter, and the rule
// that a signed-in shop can read its own wallet but can never write one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const BARBER = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const OWNER = { id: "e7000000-0000-4000-8000-00000000000a", email: "wallet-owner@test.local" };
const OTHER = { id: "e7000000-0000-4000-8000-00000000000b", email: "wallet-other@test.local" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

const brandOf = async (shopId) => (await db.query("select brand_id from public.businesses where id = $1", [shopId])).rows[0].brand_id;

async function inTx(fn) {
  await db.query("begin");
  try {
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

// An expected refusal aborts the transaction, so each one runs inside its own savepoint.
async function refused(fn, check, message) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check, message);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("a top-up is credited exactly once, however many times the server asks", { skip }, async () => {
  await inTx(async () => {
    const brand = await brandOf(SALON);
    const { rows: [topup] } = await db.query(
      "insert into public.wallet_topups (brand_id, amount, status) values ($1, 1000, 'pending') returning id",
      [brand]
    );

    const first = (await db.query("select public.wallet_apply_topup($1, $2, $3, $4) as result", [topup.id, 1000, "TX-1001", "Kiwmee"])).rows[0].result;
    assert.deepEqual([first.status, first.balance, first.already], ["credited", 1000, false]);

    const again = (await db.query("select public.wallet_apply_topup($1, $2, $3, $4) as result", [topup.id, 1000, "TX-1001", "Kiwmee"])).rows[0].result;
    assert.deepEqual([again.balance, again.already], [1000, true], "a repeated call must not add money twice");

    const entries = (await db.query("select kind, amount::float8 as amount, balance_after::float8 as after from public.wallet_entries where ref_id = $1", [topup.id])).rows;
    assert.deepEqual(entries, [{ kind: "topup", amount: 1000, after: 1000 }]);
    const status = (await db.query("select status, credit_amount::float8 as amount from public.wallet_topups where id = $1", [topup.id])).rows[0];
    assert.deepEqual(status, { status: "credited", amount: 1000 });
  });
});

test("a purchase takes the money and leaves the balance; a short wallet is refused", { skip }, async () => {
  await inTx(async () => {
    const brand = await brandOf(SALON);
    await db.query("insert into public.wallet_accounts (brand_id, balance) values ($1, 500)", [brand]);
    const { rows: [order] } = await db.query("insert into public.wallet_orders (brand_id, sku, amount) values ($1, 'msg:500', 99) returning id", [brand]);

    const paid = (await db.query("select public.wallet_charge($1, $2, 'purchase', $3, $4) as result", [brand, 99, order.id, "ข้อความ LINE เพิ่ม 500"])).rows[0].result;
    assert.equal(paid.balance, 401);

    await refused(
      () => db.query("select public.wallet_charge($1, $2, 'purchase', $3, $4)", [brand, 5000, order.id, "แพ็กเกจโปร"]),
      (e) => e.message === "INSUFFICIENT_BALANCE" && e.code === "BK422"
    );
    const balance = (await db.query("select balance::float8 as balance from public.wallet_accounts where brand_id = $1", [brand])).rows[0].balance;
    assert.equal(balance, 401, "the refused purchase leaves the balance alone");

    const entries = (await db.query("select kind, amount::float8 as amount from public.wallet_entries where brand_id = $1 order by created_at", [brand])).rows;
    assert.deepEqual(entries.map((e) => [e.kind, e.amount]), [["purchase", -99]]);
  });
});

test("message and slip usage add up within the Bangkok month", { skip }, async () => {
  await inTx(async () => {
    const brand = await brandOf(SALON);
    await db.query("select public.usage_add($1, 3, 1, 900, 0)", [brand]);
    await db.query("select public.usage_add($1, 2, 1, 0, 500)", [brand]);
    const row = (await db.query(
      `select messages_used, messages_included, messages_purchased, slips_used, period::text as period
         from public.usage_counters where brand_id = $1`,
      [brand]
    )).rows[0];
    assert.deepEqual([row.messages_used, row.messages_included, row.messages_purchased, row.slips_used], [5, 900, 500, 2]);
    assert.match(row.period, /^\d{4}-\d{2}-01$/);
  });
});

test("a signed-in owner reads their wallet but cannot write it; another shop sees nothing", { skip }, async () => {
  await inTx(async () => {
    const salonBrand = await brandOf(SALON);
    const barberBrand = await brandOf(BARBER);
    await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [OWNER.id, OWNER.email, OTHER.id, OTHER.email]);
    await db.query("insert into public.brand_members (brand_id, user_id) values ($1, $2)", [salonBrand, OWNER.id]);
    await db.query("insert into public.wallet_accounts (brand_id, balance) values ($1, 250), ($2, 999)", [salonBrand, barberBrand]);

    await admin.actAs(db, OWNER);
    const seen = (await db.query("select brand_id, balance::float8 as balance from public.wallet_accounts")).rows;
    assert.deepEqual(seen.map((r) => [r.brand_id, r.balance]), [[salonBrand, 250]], "only the owner's own brand");

    await refused(
      () => db.query("insert into public.wallet_entries (brand_id, kind, amount, balance_after) values ($1, 'topup', 10000, 10250)", [salonBrand]),
      (e) => e.code === "42501",
      "a signed-in user must not be able to mint balance"
    );
    await refused(
      () => db.query("select public.wallet_apply_topup(gen_random_uuid(), 1000, 'TX', 'x')"),
      (e) => e.code === "42501",
      "the credit function is not callable from the signed-in role"
    );
  });
});

test("only the server role may execute the money functions", { skip }, async () => {
  const privilege = async (role, signature) =>
    (await db.query("select has_function_privilege($1, $2, 'execute') as ok", [role, signature])).rows[0].ok;
  assert.equal(await privilege("authenticated", "public.wallet_apply_topup(uuid, numeric, text, text)"), false);
  assert.equal(await privilege("anon", "public.wallet_charge(uuid, numeric, text, uuid, text)"), false);
  assert.equal(await privilege("service_role", "public.wallet_apply_topup(uuid, numeric, text, text)"), true);
  assert.equal(await privilege("service_role", "public.usage_add(uuid, integer, integer, integer, integer)"), true);
});

test("the billing page counts what a brand uses against its plan (online bookings this month, active resources, people, branches)", { skip }, async () => {
  const { brandCounts } = require("../../src/v2/wallet");
  await inTx(async () => {
    const brand = await brandOf(SALON);
    const before = await brandCounts(db, brand);
    assert.ok(before.branches >= 1);

    await db.query("insert into public.resources (business_id, kind, name, capacity) values ($1, 'staff', 'ช่างนับโควตา', 1)", [SALON]);
    await db.query("insert into public.resources (business_id, kind, name, capacity, active) values ($1, 'staff', 'ช่างที่ปิดอยู่', 1, false)", [SALON]);
    await db.query("insert into auth.users (id, email) values ($1, $2)", [OTHER.id, OTHER.email]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'staff')", [SALON, OTHER.id]);
    const { rows: [booking] } = await db.query(
      `select k.id from public.bookings k join public.businesses b on b.id = k.business_id
        where b.brand_id = $1 and k.source <> 'admin' and k.created_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok' limit 1`,
      [brand]
    );
    if (booking) await db.query("update public.bookings set source = 'admin' where id = $1", [booking.id]);

    const after = await brandCounts(db, brand);
    assert.equal(after.resources, before.resources + 1, "only active resources count");
    assert.equal(after.members, before.members + 1);
    assert.equal(after.branches, before.branches);
    assert.equal(after.bookings, before.bookings - (booking ? 1 : 0), "bookings the shop enters itself do not count");

    const other = await brandCounts(db, await brandOf(BARBER));
    assert.notDeepEqual(other, after, "another brand is counted on its own");
  });
});
