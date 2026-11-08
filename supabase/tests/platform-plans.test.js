// B7 (migration …004400): /super sets a brand's plan and corrects its wallet, with a reason, and only
// for platform admins. These run the real SQL on the server's own connection and clean up after.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const ADMIN = { id: "e8300000-0000-4000-8000-000000000001", email: "plan-admin@test.local" };
const NOBODY = { id: "e8300000-0000-4000-8000-000000000002", email: "not-admin@test.local" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

test("a platform admin sets plans and adjusts wallets; every change is logged; others are refused", { skip }, async () => {
  process.env.BOOKING_DB_URL = url;
  const plans = require("../../src/v2/platform-plans");
  await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4) on conflict do nothing", [ADMIN.id, ADMIN.email, NOBODY.id, NOBODY.email]);
  await db.query("insert into public.platform_admins (user_id) values ($1) on conflict do nothing", [ADMIN.id]);
  const { rows: [shop] } = await db.query("insert into public.businesses (name, slug) values ('ร้านทีมงาน', 'super-plan-shop') returning id, brand_id");
  try {
    await assert.rejects(plans.brandAdmin(NOBODY.id, shop.brand_id), (e) => e.status === 403);
    await assert.rejects(plans.setBrandPlan(NOBODY.id, shop.brand_id, { plan: "pro", reason: "ลองดู" }), (e) => e.status === 403);
    await assert.rejects(plans.adjustWallet(NOBODY.id, shop.brand_id, { amount: 500, reason: "ลองดู" }), (e) => e.status === 403);

    const set = await plans.setBrandPlan(ADMIN.id, shop.brand_id, { plan: "pro", validUntil: "2099-01-31", complimentary: true, reason: "ร้านพาร์ตเนอร์" });
    assert.deepEqual([set.plan.plan, set.plan.effective, set.plan.complimentary, set.plan.auto_renew], ["pro", "pro", true, false]);
    assert.equal(new Date(set.plan.valid_until).toISOString(), "2099-01-31T16:59:59.000Z");

    const money = await plans.adjustWallet(ADMIN.id, shop.brand_id, { amount: 500, reason: "สลิปอ่านไม่ได้" });
    assert.equal(money.balance, 500);
    await assert.rejects(plans.adjustWallet(ADMIN.id, shop.brand_id, { amount: -600, reason: "หักเกิน" }), /ไม่เกินยอด/);
    assert.equal((await plans.adjustWallet(ADMIN.id, shop.brand_id, { amount: -100, reason: "โอนซ้ำ" })).balance, 400);

    // back to free: what Pro covered is paused by plan_sync
    await db.query("insert into public.loyalty_programs (brand_id, active, earn_per_baht) values ($1, true, 100)", [shop.brand_id]);
    const free = await plans.setBrandPlan(ADMIN.id, shop.brand_id, { plan: "free", reason: "จบช่วงพาร์ตเนอร์" });
    assert.deepEqual([free.plan.effective, free.plan.valid_until, free.sync.paused], ["free", null, 1]);

    const detail = await plans.brandAdmin(ADMIN.id, shop.brand_id);
    assert.equal(detail.balance, 400);
    assert.deepEqual(detail.changes.map((c) => [c.action, c.reason, c.admin_email]), [
      ["set_plan", "จบช่วงพาร์ตเนอร์", ADMIN.email],
      ["adjust_wallet", "โอนซ้ำ", ADMIN.email],
      ["adjust_wallet", "สลิปอ่านไม่ได้", ADMIN.email],
      ["set_plan", "ร้านพาร์ตเนอร์", ADMIN.email]
    ]);
    assert.deepEqual(detail.entries.map((e) => [e.kind, e.amount, e.balance_after]), [["adjust", -100, 400], ["adjust", 500, 500]]);
    assert.match(detail.entries[0].note, /ทีมงาน: โอนซ้ำ/);

    // nobody signed in reads the log or calls the money function
    await db.query("begin");
    await db.query("set local role authenticated");
    for (const sql of ["select * from public.platform_plan_changes", `select public.wallet_adjust('${shop.brand_id}', 1, 'x', null)`]) {
      await db.query("savepoint s");
      await assert.rejects(() => db.query(sql), (e) => e.code === "42501", sql);
      await db.query("rollback to savepoint s");
    }
    await db.query("rollback");
  } finally {
    await db.query("delete from public.businesses where brand_id = $1", [shop.brand_id]);
    await db.query("delete from public.brands where id = $1", [shop.brand_id]);
    await db.query("delete from public.platform_admins where user_id = $1", [ADMIN.id]);
    await db.query("delete from auth.users where id in ($1, $2)", [ADMIN.id, NOBODY.id]);
    await require("../../src/v2/db").getBookingPool().end().catch(() => {});
  }
});
