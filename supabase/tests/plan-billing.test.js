// B4 (migration …004200): the 14-day trial, grace days, pausing what a plan no longer includes, and
// the wallet's plan purchases / renewals running their real SQL against the database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const NEW_OWNER = { id: "e8200000-0000-4000-8000-000000000001", email: "trial-owner@test.local" };
const MONEY_OWNER = { id: "e8200000-0000-4000-8000-000000000002", email: "money-owner@test.local" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

async function inTx(fn) {
  await db.query("begin");
  try {
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

const planRow = async (brand) =>
  (await db.query("select plan, complimentary, trial, auto_renew, cycle, next_plan, valid_until, grace_until, public.brand_plan(brand_id) as effective from public.brand_plans where brand_id = $1", [brand])).rows[0];

async function newShop(user, slug) {
  await admin.actAs(db, user);
  await admin.createShop(db, { name: `ร้าน ${slug}`, slug, kind: "salon" });
  await db.query("reset role");
  return (await db.query("select id, brand_id from public.businesses where slug = $1", [slug])).rows[0];
}

test("a person's first brand gets Pro free for 14 days, once; later brands start free", { skip }, async () => {
  await inTx(async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [NEW_OWNER.id, NEW_OWNER.email]);
    const first = await newShop(NEW_OWNER, "trial-first");
    const p = await planRow(first.brand_id);
    assert.deepEqual([p.effective, p.complimentary, p.trial, p.auto_renew], ["pro", true, true, false]);
    const days = (new Date(p.valid_until) - Date.now()) / 864e5;
    assert.ok(days > 13.9 && days <= 14, `14 days, got ${days}`);

    const second = await newShop(NEW_OWNER, "trial-second");
    assert.equal((await planRow(second.brand_id)).effective, "free", "one trial per person");

    // the trial ends: free again, and the shop's data stays
    await db.query("update public.brand_plans set valid_until = now() - interval '1 minute' where brand_id = $1", [first.brand_id]);
    assert.equal((await planRow(first.brand_id)).effective, "free");
    assert.equal((await db.query("select count(*)::int as n from public.businesses where id = $1", [first.id])).rows[0].n, 1);
  });
});

test("people who owned a brand before …004200 do not get a trial (the launch offer covers them)", { skip }, async () => {
  await inTx(async () => {
    const owner = (await db.query("select user_id from public.brand_members limit 1")).rows[0];
    if (!owner) return; // a fresh test database has no owners before the tests add them
    const { rows: [r] } = await db.query("select count(*)::int as n from public.plan_trials where user_id = $1", [owner.user_id]);
    assert.equal(r.n, 1);
  });
});

test("grace days keep the plan; after them the brand is free", { skip }, async () => {
  await inTx(async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [NEW_OWNER.id, NEW_OWNER.email]);
    const shop = await newShop(NEW_OWNER, "grace-shop");
    await db.query("update public.brand_plans set plan = 'starter', complimentary = false, trial = false, valid_until = now() - interval '1 day', grace_until = now() + interval '6 days' where brand_id = $1", [shop.brand_id]);
    assert.equal((await planRow(shop.brand_id)).effective, "starter");
    await db.query("update public.brand_plans set grace_until = now() - interval '1 minute' where brand_id = $1", [shop.brand_id]);
    assert.equal((await planRow(shop.brand_id)).effective, "free");
  });
});

test("plan_sync pauses what a plan lacks and resumes it when the plan returns; nothing is deleted", { skip }, async () => {
  await inTx(async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [NEW_OWNER.id, NEW_OWNER.email]);
    const shop = await newShop(NEW_OWNER, "sync-shop"); // on the Pro trial: everything may be switched on
    for (let i = 1; i <= 6; i++) {
      await db.query("insert into public.resources (business_id, kind, name, capacity, sort_order) values ($1, 'staff', $2, 1, $3)", [shop.id, `ช่าง ${i}`, i]);
    }
    await db.query("insert into public.resources (business_id, kind, name, capacity) values ($1, 'equipment', 'ไม้แบด', 10)", [shop.id]);
    await db.query("insert into public.loyalty_programs (brand_id, active, earn_per_baht) values ($1, true, 100)", [shop.brand_id]);
    await db.query("insert into public.addon_groups (business_id, name) values ($1, 'เพิ่มเติม')", [shop.id]);
    await db.query("insert into public.offerings (business_id, name, duration_mode, min_days, max_days) values ($1, 'เช่ากล้อง', 'days', 1, 3)", [shop.id]);
    await db.query("insert into public.offerings (business_id, name, duration_minutes) values ($1, 'ตัดผม', 60)", [shop.id]);

    // the trial ends: free (2 staff, no points, no add-ons, no rentals)
    await db.query("update public.brand_plans set valid_until = now() - interval '1 minute' where brand_id = $1", [shop.brand_id]);
    const paused = (await db.query("select public.plan_sync($1) as r", [shop.brand_id])).rows[0].r;
    assert.equal(paused.plan, "free");
    const staff = (await db.query("select name, active, paused_by_plan from public.resources where business_id = $1 and kind = 'staff' order by sort_order", [shop.id])).rows;
    assert.deepEqual(staff.map((r) => [r.name, r.active, r.paused_by_plan]), [
      ["ช่าง 1", true, false], ["ช่าง 2", true, false],
      ["ช่าง 3", false, true], ["ช่าง 4", false, true], ["ช่าง 5", false, true], ["ช่าง 6", false, true]
    ]);
    assert.equal((await db.query("select active from public.resources where business_id = $1 and kind = 'equipment'", [shop.id])).rows[0].active, true, "add-on stock is not a staff seat");
    assert.deepEqual((await db.query("select active, paused_by_plan from public.loyalty_programs where brand_id = $1", [shop.brand_id])).rows[0], { active: false, paused_by_plan: true });
    assert.deepEqual((await db.query("select active, paused_by_plan from public.addon_groups where business_id = $1", [shop.id])).rows[0], { active: false, paused_by_plan: true });
    assert.deepEqual(
      (await db.query("select name, active, paused_by_plan from public.offerings where business_id = $1 order by duration_mode", [shop.id])).rows, // days < fixed, whatever the collation
      [{ name: "เช่ากล้อง", active: false, paused_by_plan: true }, { name: "ตัดผม", active: true, paused_by_plan: false }]
    );
    assert.equal((await db.query("select public.plan_sync($1) as r", [shop.brand_id])).rows[0].r.paused, 0, "running it again changes nothing");

    // starter: 5 staff and add-ons come back; points and rentals stay paused
    await db.query("update public.brand_plans set plan = 'starter', complimentary = false, trial = false, valid_until = now() + interval '30 days' where brand_id = $1", [shop.brand_id]);
    await db.query("select public.plan_sync($1)", [shop.brand_id]);
    assert.equal((await db.query("select count(*)::int as n from public.resources where business_id = $1 and kind = 'staff' and active", [shop.id])).rows[0].n, 5);
    assert.equal((await db.query("select active from public.addon_groups where business_id = $1", [shop.id])).rows[0].active, true);
    assert.equal((await db.query("select active from public.loyalty_programs where brand_id = $1", [shop.brand_id])).rows[0].active, false);

    // pro: everything is back, flags cleared
    await db.query("update public.brand_plans set plan = 'pro' where brand_id = $1", [shop.brand_id]);
    await db.query("select public.plan_sync($1)", [shop.brand_id]);
    const left = (await db.query(
      `select (select count(*) from public.resources where business_id = $1 and paused_by_plan)
            + (select count(*) from public.offerings where business_id = $1 and paused_by_plan)
            + (select count(*) from public.addon_groups where business_id = $1 and paused_by_plan)
            + (select count(*) from public.loyalty_programs where brand_id = $2 and paused_by_plan) as n`, [shop.id, shop.brand_id])).rows[0].n;
    assert.equal(Number(left), 0);
    assert.equal((await db.query("select count(*)::int as n from public.resources where business_id = $1 and kind = 'staff' and active", [shop.id])).rows[0].n, 6);
  });
});

test("only the server may start trials or sync plans; nobody signed in reads the trial list", { skip }, async () => {
  await inTx(async () => {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [NEW_OWNER.id, NEW_OWNER.email]);
    await admin.actAs(db, NEW_OWNER);
    for (const sql of ["select public.start_trial(gen_random_uuid(), gen_random_uuid())", "select public.plan_sync(gen_random_uuid())", "select public.plan_sync_all()", "select * from public.plan_trials"]) {
      await db.query("savepoint s");
      await assert.rejects(() => db.query(sql), (e) => e.code === "42501", sql);
      await db.query("rollback to savepoint s");
    }
  });
});

// The wallet runs on its own connection and commits: these use a brand made here and removed after.
test("buying a plan, scheduling a cheaper one, and the hourly renewal run their real SQL", { skip }, async () => {
  process.env.BOOKING_DB_URL = url;
  const wallet = require("../../src/v2/wallet");
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [MONEY_OWNER.id, MONEY_OWNER.email]);
  await db.query("begin");
  const shop = await newShop(MONEY_OWNER, "money-shop");
  await db.query("commit");
  try {
    await db.query("update public.brand_plans set plan = 'free', complimentary = false, trial = false, valid_until = null where brand_id = $1", [shop.brand_id]);
    await db.query("insert into public.wallet_accounts (brand_id, balance) values ($1, 3000)", [shop.brand_id]);

    const bought = await wallet.buy(shop.brand_id, MONEY_OWNER.id, "plan:starter");
    assert.deepEqual([bought.paid, bought.balance, bought.plan.mode], [390, 2610, "new"]);
    let p = await planRow(shop.brand_id);
    assert.deepEqual([p.plan, p.cycle, p.complimentary, p.auto_renew], ["starter", "month", false, true]);

    // upgrade mid-period: the difference for the days left, same end date
    const end = p.valid_until;
    const up = await wallet.buy(shop.brand_id, MONEY_OWNER.id, "plan:pro");
    assert.equal(up.plan.mode, "upgrade");
    assert.ok(up.paid >= 499 && up.paid <= 500, `about 500 for a whole month left, got ${up.paid}`);
    p = await planRow(shop.brand_id);
    assert.deepEqual([p.plan, new Date(p.valid_until).getTime()], ["pro", new Date(end).getTime()]);

    // cheaper is refused as a purchase, and set for the next renewal instead
    await assert.rejects(() => wallet.buy(shop.brand_id, MONEY_OWNER.id, "plan:starter"), (e) => e.details?.reason === "SCHEDULE_INSTEAD");
    await wallet.setPlanOptions(shop.brand_id, MONEY_OWNER.id, { autoRenew: true, nextPlan: "starter" });
    assert.equal((await planRow(shop.brand_id)).next_plan, "starter");

    // the renewal: due within 3 days, pays the scheduled plan, runs on from the old end
    await db.query("update public.brand_plans set valid_until = now() + interval '2 days' where brand_id = $1", [shop.brand_id]);
    const before = (await planRow(shop.brand_id)).valid_until;
    const run = await wallet.renewDuePlans();
    assert.ok(run.renewed >= 1);
    p = await planRow(shop.brand_id);
    assert.deepEqual([p.plan, p.next_plan], ["starter", null]);
    assert.equal(Math.round((new Date(p.valid_until) - new Date(before)) / 864e5), 30);

    // an empty wallet at the end: 7 grace days, then free and paused
    await db.query("update public.wallet_accounts set balance = 0 where brand_id = $1", [shop.brand_id]);
    await db.query("update public.brand_plans set valid_until = now() - interval '1 hour' where brand_id = $1", [shop.brand_id]);
    await wallet.renewDuePlans();
    p = await planRow(shop.brand_id);
    assert.equal(p.effective, "starter");
    assert.ok(p.grace_until && new Date(p.grace_until) > new Date(), "grace days started");

    // turning auto-renew off: the plan just ends, nothing is charged
    await wallet.setPlanOptions(shop.brand_id, MONEY_OWNER.id, { autoRenew: false });
    assert.equal((await planRow(shop.brand_id)).auto_renew, false);
  } finally {
    await db.query("delete from public.businesses where brand_id = $1", [shop.brand_id]);
    await db.query("delete from public.brands where id = $1", [shop.brand_id]);
    await db.query("delete from public.plan_trials where user_id = $1", [MONEY_OWNER.id]);
    await db.query("delete from auth.users where id = $1", [MONEY_OWNER.id]);
    await require("../../src/v2/db").getBookingPool().end().catch(() => {});
  }
});
