// B3 (migration …004100): the database enforces what each package allows. The package table in SQL
// equals src/v2/plans.js; every guard refuses only adding or switching on, never what is there.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { PLANS } = require("../../src/v2/plans");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair (Pro in seed.sql)
const CUT = "c1000000-0000-4000-8000-000000000001";
const OWNER = { id: "e8100000-0000-4000-8000-000000000001", email: "plan-owner@test.local" };
const FRIEND = { id: "e8100000-0000-4000-8000-000000000002", email: "plan-friend@test.local" };

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

async function refused(fn, reason) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, (e) => e.code === "BK422" && e.message === reason, reason);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

// A brand-new shop on the free plan, owned by OWNER; returns its id
async function freeShop() {
  await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [OWNER.id, OWNER.email, FRIEND.id, FRIEND.email]);
  await admin.actAs(db, OWNER);
  await admin.createShop(db, { name: "ร้านแพ็กเกจฟรี", slug: "plan-free-shop", kind: "salon" });
  await db.query("reset role");
  const { rows: [shop] } = await db.query("select id, brand_id from public.businesses where slug = 'plan-free-shop'");
  assert.equal((await db.query("select public.brand_plan($1) as p", [shop.brand_id])).rows[0].p, "free");
  return shop;
}

const SQL_KEY = { bookingsPerMonth: "bookings_per_month", resources: "resources", members: "members", branches: "branches", messages: "messages", slipChecks: "slip_checks" };
const SQL_FEATURE = { onlineBooking: "online_booking", reminders: "reminders", addons: "addons", rentals: "rentals", layout: "layout", loyalty: "loyalty", export: "export" };

test("the package table in the database equals src/v2/plans.js", { skip }, async () => {
  for (const plan of PLANS) {
    for (const [jsKey, sqlKey] of Object.entries(SQL_KEY)) {
      const { rows: [r] } = await db.query("select public.plan_limit($1, $2) as v", [plan.id, sqlKey]);
      assert.equal(r.v, plan.limits[jsKey], `${plan.id}.${jsKey}`);
    }
    for (const [jsKey, sqlKey] of Object.entries(SQL_FEATURE)) {
      const { rows: [r] } = await db.query("select public.plan_has($1, $2) as v", [plan.id, sqlKey]);
      assert.equal(r.v, plan.features[jsKey], `${plan.id}.${jsKey}`);
    }
    const { rows: [b] } = await db.query("select public.brand_branch_limit($1) as v", [plan.id]);
    assert.equal(b.v, plan.limits.branches ?? 1000);
  }
});

test("free plan: two active staff/courts (equipment for add-ons does not count), then upgrade", { skip }, async () => {
  await inTx(async () => {
    const shop = await freeShop();
    const add = (name, kind = "staff", active = true) =>
      db.query("insert into public.resources (business_id, kind, name, capacity, active) values ($1, $2, $3, 1, $4) returning id", [shop.id, kind, name, active]);
    await add("ช่าง 1");
    const { rows: [second] } = await add("ช่าง 2");
    await refused(() => add("ช่าง 3"), "PLAN_RESOURCES");
    await add("ไม้แบด", "equipment"); // add-on stock is not a staff seat
    const { rows: [off] } = await add("ช่างพักงาน", "staff", false); // a switched-off one waits
    await refused(() => db.query("update public.resources set active = true where id = $1", [off.id]), "PLAN_RESOURCES");
    await db.query("update public.resources set active = false where id = $1", [second.id]);
    await db.query("update public.resources set active = true where id = $1", [off.id]); // swap is fine

    await db.query("update public.brand_plans set plan = 'starter', valid_until = now() + interval '30 days' where brand_id = $1", [shop.brand_id]);
    await add("ช่าง 3");
    await add("ช่าง 4");
    await add("ช่าง 5");
    await refused(() => add("ช่าง 6"), "PLAN_RESOURCES");
  });
});

test("features a plan lacks cannot be switched on: map, add-ons, rentals, points", { skip }, async () => {
  await inTx(async () => {
    const shop = await freeShop();
    const { rows: [court] } = await db.query("insert into public.resources (business_id, kind, name, capacity) values ($1, 'court', 'คอร์ต 1', 1) returning id", [shop.id]);
    await refused(() => db.query("update public.resources set layout_row = 1, layout_col = 1, layout_w = 1, layout_h = 1 where id = $1", [court.id]), "PLAN_FEATURE_LAYOUT");
    await refused(() => db.query("insert into public.addon_groups (business_id, name) values ($1, 'เช่าไม้')", [shop.id]), "PLAN_FEATURE_ADDONS");
    await refused(
      () => db.query("insert into public.offerings (business_id, name, duration_mode, min_days, max_days) values ($1, 'เช่ากล้อง', 'days', 1, 3)", [shop.id]),
      "PLAN_FEATURE_RENTALS"
    );
    await refused(() => db.query("insert into public.loyalty_programs (brand_id, active, earn_per_baht) values ($1, true, 100)", [shop.brand_id]), "PLAN_FEATURE_LOYALTY");
    // switched off, the same things can still be saved (the setup is kept for later)
    await db.query("insert into public.loyalty_programs (brand_id, active, earn_per_baht) values ($1, false, 100)", [shop.brand_id]);
    await db.query("insert into public.addon_groups (business_id, name, active) values ($1, 'เช่าไม้', false)", [shop.id]);

    // starter: add-ons yes, map / rentals / points no; pro: all of them
    await db.query("update public.brand_plans set plan = 'starter', valid_until = now() + interval '30 days' where brand_id = $1", [shop.brand_id]);
    await db.query("insert into public.addon_groups (business_id, name) values ($1, 'ทรีตเมนต์เพิ่ม')", [shop.id]);
    await refused(() => db.query("update public.loyalty_programs set active = true where brand_id = $1", [shop.brand_id]), "PLAN_FEATURE_LOYALTY");
    await db.query("update public.brand_plans set plan = 'pro' where brand_id = $1", [shop.brand_id]);
    await db.query("update public.resources set layout_row = 1, layout_col = 1, layout_w = 1, layout_h = 1 where id = $1", [court.id]);
    await db.query("insert into public.offerings (business_id, name, duration_mode, min_days, max_days) values ($1, 'เช่ากล้อง', 'days', 1, 3)", [shop.id]);
    await db.query("update public.loyalty_programs set active = true where brand_id = $1", [shop.brand_id]);
  });
});

test("people: the free plan is the owner alone; an invite takes its seat when sent and is accepted later", { skip }, async () => {
  await inTx(async () => {
    const shop = await freeShop();
    await admin.actAs(db, OWNER);
    await refused(() => db.query("select public.invite_member($1, $2, 'staff')", [shop.id, "someone@test.local"]), "PLAN_MEMBERS");
    await db.query("reset role");
    await refused(() => db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'staff')", [shop.id, FRIEND.id]), "PLAN_MEMBERS");

    // starter: three people. An invite to someone without an account holds a seat.
    await db.query("update public.brand_plans set plan = 'starter', valid_until = now() + interval '30 days' where brand_id = $1", [shop.brand_id]);
    await admin.actAs(db, OWNER);
    await db.query("select public.invite_member($1, $2, 'staff')", [shop.id, "later@test.local"]);
    await db.query("select public.invite_member($1, $2, 'staff')", [shop.id, FRIEND.email]); // has an account: joins now
    await refused(() => db.query("select public.invite_member($1, $2, 'staff')", [shop.id, "fourth@test.local"]), "PLAN_MEMBERS");
    await db.query("reset role");
    assert.equal((await db.query("select public.brand_people($1) as n", [shop.brand_id])).rows[0].n, 3);

    // the invited person signs up and accepts: not refused, the seat was already theirs
    await db.query("insert into auth.users (id, email) values ('e8100000-0000-4000-8000-000000000003', 'later@test.local')");
    await admin.actAs(db, { id: "e8100000-0000-4000-8000-000000000003", email: "later@test.local" });
    await db.query("select public.accept_my_invites()");
    await db.query("reset role");
    assert.equal((await db.query("select public.brand_people($1) as n", [shop.brand_id])).rows[0].n, 3);
  });
});

test("online bookings: 50 a month on free (the shop's own entries never count), none on the loyalty-only plan", { skip }, async () => {
  await inTx(async () => {
    const brand = (await db.query("select brand_id from public.businesses where id = $1", [SALON])).rows[0].brand_id;
    const { rows: [customer] } = await db.query("insert into public.customers (business_id, name) values ($1, 'ลูกค้าโควตา') returning id", [SALON]);
    const insert = (n, source = "web") =>
      db.query(
        `insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at, status, source)
         select $1, $2, $3, now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '1 hour', 'cancelled', $5
           from generate_series(1, $4) g`,
        [SALON, customer.id, CUT, n, source]
      );
    await db.query("update public.brand_plans set plan = 'free', valid_until = null where brand_id = $1", [brand]);
    const already = (await db.query("select public.brand_month_online_bookings($1) as n", [brand])).rows[0].n;
    assert.ok(already < 50);
    await insert(50 - already);
    assert.equal((await db.query("select public.business_online_open($1) as open", [SALON])).rows[0].open, false);
    await refused(() => insert(1), "PLAN_BOOKINGS_FULL");
    await insert(3, "admin"); // the shop can always enter bookings itself
    await refused(
      () => db.query(`select public.create_booking($1, $2, (current_date + 2 || ' 11:00+07')::timestamptz, '{"name":"ลูกค้า"}'::jsonb, null, null, 1, false)`, [SALON, CUT]),
      "PLAN_BOOKINGS_FULL"
    );

    await db.query("update public.brand_plans set plan = 'starter', valid_until = now() + interval '30 days' where brand_id = $1", [brand]);
    assert.equal((await db.query("select public.business_online_open($1) as open", [SALON])).rows[0].open, true);
    await insert(1);

    await db.query("update public.brand_plans set plan = 'loyalty' where brand_id = $1", [brand]);
    assert.equal((await db.query("select public.business_online_open($1) as open", [SALON])).rows[0].open, false);
    await refused(() => insert(1), "PLAN_ONLINE_OFF");
    await insert(1, "admin");
  });
});

test("a complimentary plan is a plan like any other until it ends, then the brand is free", { skip }, async () => {
  await inTx(async () => {
    const shop = await freeShop();
    await db.query("update public.brand_plans set plan = 'pro', valid_until = now() + interval '1 day', complimentary = true where brand_id = $1", [shop.brand_id]);
    assert.equal((await db.query("select public.brand_plan($1) as p", [shop.brand_id])).rows[0].p, "pro");
    await db.query("update public.brand_plans set valid_until = now() - interval '1 minute' where brand_id = $1", [shop.brand_id]);
    assert.equal((await db.query("select public.brand_plan($1) as p", [shop.brand_id])).rows[0].p, "free");
  });
});

test("anonymous callers may only ask whether a shop takes online bookings", { skip }, async () => {
  await inTx(async () => {
    await db.query("set local role anon");
    assert.equal((await db.query("select public.business_online_open($1) as open", [SALON])).rows[0].open, true);
    for (const sql of [
      "select public.brand_month_online_bookings(gen_random_uuid())",
      "select public.brand_people(gen_random_uuid())",
      "select public.business_plan(gen_random_uuid())",
      "select public.plan_refuse('X')"
    ]) {
      await db.query("savepoint s");
      await assert.rejects(() => db.query(sql), (e) => e.code === "42501", sql);
      await db.query("rollback to savepoint s");
    }
  });
});
