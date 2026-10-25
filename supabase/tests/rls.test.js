// Tenant isolation and integrity of the v2 schema, against a database built by scripts/db-test.sh.
// Each check runs in a transaction as a real Supabase role (anon / authenticated with a user id)
// and is rolled back, so the checks don't depend on each other.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SHOP_A = "b1000000-0000-4000-8000-000000000001"; // Bloom Hair & Beauty
const SHOP_B = "b2000000-0000-4000-8000-000000000002"; // Gentleman Barber
const OFFERING_A = "c1000000-0000-4000-8000-000000000001";
const STAFF_A = "a1000000-0000-4000-8000-000000000001";
const STAFF_B = "a2000000-0000-4000-8000-000000000001";
const OFFERING_B = "c2000000-0000-4000-8000-000000000001";

const USERS = {
  ownerA: "e1000000-0000-4000-8000-00000000000a",
  staffA: "e1000000-0000-4000-8000-00000000000b",
  ownerB: "e2000000-0000-4000-8000-00000000000a",
  outsider: "e9000000-0000-4000-8000-000000000009"
};

let db;

test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[]) on conflict do nothing", [
    Object.values(USERS),
    Object.keys(USERS).map((k) => `${k}@test.local`)
  ]);
  await db.query(
    `insert into public.business_members (business_id, user_id, role) values
       ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner') on conflict do nothing`,
    [SHOP_A, SHOP_B, USERS.ownerA, USERS.staffA, USERS.ownerB]
  );
});

test.after(async () => {
  if (db) await db.end();
});

/** Runs fn inside a rolled-back transaction as the given role (and user, for authenticated). */
async function as(role, userId, fn) {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    if (userId) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

const rows = async (sql, params) => (await db.query(sql, params)).rows;

/** Expects the statement to fail, inside a savepoint so the surrounding transaction stays usable. */
async function refused(sql, params, pattern, message) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(db.query(sql, params), pattern, message);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("anon reads no table at all", { skip }, async () => {
  for (const table of ["businesses", "business_members", "resources", "offerings", "price_rules", "booking_flows", "customers", "bookings"]) {
    await as("anon", null, async () => {
      await refused(`select 1 from public.${table} limit 1`, [], /permission denied/, table);
    });
  }
});

test("anon cannot call the internal or signed-in functions", { skip }, async () => {
  for (const sql of [
    `select public.create_business('x', 'x-shop')`,
    `select public.is_business_member('${SHOP_A}')`
  ]) {
    await as("anon", null, async () => {
      await refused(sql, [], /permission denied/, sql);
    });
  }
});

test("a member sees only their own shop", { skip }, async () => {
  await as("authenticated", USERS.staffA, async () => {
    const shops = await rows("select id from public.businesses");
    assert.deepEqual(shops.map((r) => r.id), [SHOP_A]);
    const offerings = await rows("select distinct business_id from public.offerings");
    assert.deepEqual(offerings.map((r) => r.business_id), [SHOP_A]);
    assert.equal((await rows("select 1 from public.resources where business_id = $1", [SHOP_B])).length, 0);
  });
});

test("someone with no shop sees nothing", { skip }, async () => {
  await as("authenticated", USERS.outsider, async () => {
    for (const table of ["businesses", "resources", "offerings", "price_rules", "booking_flows"]) {
      assert.equal((await rows(`select 1 from public.${table}`)).length, 0, table);
    }
  });
});

test("staff read the catalog but only owners change it", { skip }, async () => {
  await as("authenticated", USERS.staffA, async () => {
    await refused("insert into public.offerings (business_id, name, duration_minutes) values ($1, 'x', 30)", [SHOP_A], /row-level security/);
    const updated = await db.query("update public.offerings set name = 'hacked' where id = $1", [OFFERING_A]);
    assert.equal(updated.rowCount, 0);
  });
  await as("authenticated", USERS.ownerA, async () => {
    await db.query("insert into public.offerings (business_id, name, duration_minutes) values ($1, 'ดัดผม', 90)", [SHOP_A]);
    const updated = await db.query("update public.offerings set name = 'ตัดผมหญิง' where id = $1", [OFFERING_A]);
    assert.equal(updated.rowCount, 1);
  });
});

test("an owner cannot write into another shop", { skip }, async () => {
  await as("authenticated", USERS.ownerA, async () => {
    await refused("insert into public.resources (business_id, kind, name) values ($1, 'staff', 'x')", [SHOP_B], /row-level security/);
    // the owner can see their own stylist, so the update is attempted and WITH CHECK refuses it
    await refused("update public.resources set business_id = $1 where id = $2", [SHOP_B, STAFF_A], /row-level security/);
    // shop B's stylist is invisible: nothing to update
    const touched = await db.query("update public.resources set name = 'x' where id = $1", [STAFF_B]);
    assert.equal(touched.rowCount, 0);
  });
  await as("authenticated", USERS.ownerA, async () => {
    // moving a row the owner can see into another shop fails the WITH CHECK
    await refused("update public.offerings set business_id = $1 where id = $2", [SHOP_B, OFFERING_A], /row-level security|violates foreign key/);
  });
});

test("only owners manage members", { skip }, async () => {
  await as("authenticated", USERS.staffA, async () => {
    await refused("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')", [SHOP_A, USERS.outsider], /row-level security/);
    const promoted = await db.query("update public.business_members set role = 'owner' where user_id = $1", [USERS.staffA]);
    assert.equal(promoted.rowCount, 0);
  });
  await as("authenticated", USERS.ownerA, async () => {
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'staff')", [SHOP_A, USERS.outsider]);
    await refused("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'staff')", [SHOP_B, USERS.outsider], /row-level security/);
  });
});

test("create_business makes the caller its owner with default settings and flow", { skip }, async () => {
  await as("authenticated", USERS.outsider, async () => {
    const [{ create_business: id }] = await rows("select public.create_business('ร้านใหม่', 'new-shop', 'barber')");
    assert.equal((await rows("select role from public.business_members where business_id = $1", [id]))[0].role, "owner");
    assert.equal((await rows("select 1 from public.business_booking_settings where business_id = $1", [id])).length, 1);
    const [flow] = await rows("select entry, require from public.booking_flows where business_id = $1", [id]);
    assert.deepEqual(flow.entry, ["date", "offering"]);
    assert.deepEqual(flow.require, ["offering", "date", "time"]);
  });
});

test("bookings are read-only for members until the booking RPCs exist", { skip }, async () => {
  await as("authenticated", USERS.ownerA, async () => {
    await refused(
        "insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at) values ($1, gen_random_uuid(), $2, now(), now() + interval '1 hour')",
        [SHOP_A, OFFERING_A]
      , /permission denied/);
  });
});

test("rows cannot point at another shop's data, even from the service role", { skip }, async () => {
  await as("service_role", null, async () => {
    // shop A's offering performed by shop B's barber
    await refused("insert into public.offering_resources (business_id, offering_id, resource_id) values ($1, $2, $3)", [SHOP_A, OFFERING_A, STAFF_B], /violates foreign key/);
    const [customer] = await rows("insert into public.customers (business_id, name) values ($1, 'ลูกค้า B') returning id", [SHOP_B]);
    await refused(
        "insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at) values ($1, $2, $3, now(), now() + interval '1 hour')",
        [SHOP_A, customer.id, OFFERING_A]
      , /violates foreign key/);
  });
});

async function newBooking(shop, offering, start, end, status = "confirmed") {
  const [customer] = await rows("insert into public.customers (business_id, name) values ($1, 'ลูกค้า') returning id", [shop]);
  const [booking] = await rows(
    `insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at, status, hold_expires_at)
     values ($1, $2, $3, $4, $5, $6, case when $6 = 'held' then now() + interval '10 minutes' end) returning id`,
    [shop, customer.id, offering, start, end, status]
  );
  return booking.id;
}

const holdResource = (shop, booking, resource, start, end) =>
  db.query(
    "insert into public.booking_resources (business_id, booking_id, resource_id, range) values ($1, $2, $3, tstzrange($4, $5, '[)'))",
    [shop, booking, resource, start, end]
  );

test("the database refuses two bookings of one stylist at the same time", { skip }, async () => {
  await as("service_role", null, async () => {
    const s = "2026-11-02T10:00:00+07:00";
    const e = "2026-11-02T11:10:00+07:00";
    await holdResource(SHOP_A, await newBooking(SHOP_A, OFFERING_A, s, e), STAFF_A, s, e);
    const second = await newBooking(SHOP_A, OFFERING_A, "2026-11-02T11:00:00+07:00", "2026-11-02T12:00:00+07:00");
    await refused(
      "insert into public.booking_resources (business_id, booking_id, resource_id, range) values ($1, $2, $3, tstzrange($4, $5, '[)'))",
      [SHOP_A, second, STAFF_A, "2026-11-02T11:00:00+07:00", "2026-11-02T12:00:00+07:00"],
      /booking_resources_no_overlap/
    );
    // back to back is fine: ranges are [start, end)
    const third = await newBooking(SHOP_A, OFFERING_A, e, "2026-11-02T12:10:00+07:00");
    await holdResource(SHOP_A, third, STAFF_A, e, "2026-11-02T12:10:00+07:00");
  });
});

test("a cancelled booking frees its slot", { skip }, async () => {
  await as("service_role", null, async () => {
    const s = "2026-11-03T10:00:00+07:00";
    const e = "2026-11-03T11:00:00+07:00";
    const first = await newBooking(SHOP_A, OFFERING_A, s, e);
    await holdResource(SHOP_A, first, STAFF_A, s, e);
    await db.query("update public.bookings set status = 'cancelled' where id = $1", [first]);
    await holdResource(SHOP_A, await newBooking(SHOP_A, OFFERING_A, s, e), STAFF_A, s, e);
  });
});

test("resources with capacity above 1 are not limited by the overlap constraint", { skip }, async () => {
  await as("service_role", null, async () => {
    const [room] = await rows(
      "insert into public.resources (business_id, kind, name, capacity) values ($1, 'room', 'ห้องสปา 4 เตียง', 4) returning id",
      [SHOP_A]
    );
    const s = "2026-11-04T10:00:00+07:00";
    const e = "2026-11-04T11:00:00+07:00";
    for (let i = 0; i < 2; i++) await holdResource(SHOP_A, await newBooking(SHOP_A, OFFERING_A, s, e), room.id, s, e);
    const [{ exclusive }] = await rows("select bool_or(exclusive) as exclusive from public.booking_resources where resource_id = $1", [room.id]);
    assert.equal(exclusive, false); // set from capacity by trigger, whatever the writer sends
  });
});

test("a held booking must say when the hold ends", { skip }, async () => {
  await as("service_role", null, async () => {
    const [customer] = await rows("insert into public.customers (business_id, name) values ($1, 'x') returning id", [SHOP_A]);
    await refused(
        "insert into public.bookings (business_id, customer_id, offering_id, start_at, end_at, status) values ($1, $2, $3, now(), now() + interval '1 hour', 'held')",
        [SHOP_A, customer.id, OFFERING_A]
      , /check constraint/);
  });
});

test("booking flows that could never finish are refused", { skip }, async () => {
  const bad = [
    ["no time step", "array['offering','date']", "array['date','offering']"],
    ["starts from a step nobody chooses", "array['offering','date','time']", "array['duration']"],
    ["unknown entry", "array['offering','date','time']", "array['time']"]
  ];
  for (const [label, require, entry] of bad) {
    await as("service_role", null, async () => {
      await refused(`insert into public.booking_flows (business_id, category, require, entry) values ($1, 'test', ${require}, ${entry})`, [SHOP_A], /check constraint/,
        label);
    });
  }
  await as("service_role", null, async () => {
    await refused(`insert into public.booking_flows (business_id, category, "then") values ($1, 'test', array['payment'])`, [SHOP_A],
      /check constraint/, "no customer step");
  });
});

test("seed: both demo shops are complete", { skip }, async () => {
  const counts = await rows(
    `select b.slug,
            (select count(*) from public.offerings o where o.business_id = b.id)::int as offerings,
            (select count(*) from public.resources r where r.business_id = b.id)::int as staff,
            (select count(*) from public.price_rules p where p.business_id = b.id)::int as prices,
            (select count(*) from public.booking_flows f where f.business_id = b.id)::int as flows
     from public.businesses b order by b.slug`
  );
  assert.deepEqual(counts, [
    { slug: "bloom-hair", offerings: 3, staff: 3, prices: 3, flows: 1 },
    { slug: "gentleman-barber", offerings: 2, staff: 2, prices: 3, flows: 1 }
  ]);
  const colourOnly = await rows("select offering_id from public.offering_resources where resource_id = 'a1000000-0000-4000-8000-000000000003'");
  assert.deepEqual(colourOnly.map((r) => r.offering_id), ["c1000000-0000-4000-8000-000000000002"]);
  assert.equal(OFFERING_B.startsWith("c2"), true);
});
