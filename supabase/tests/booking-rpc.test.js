// Booking RPCs (step 3) against a database built by scripts/db-test.sh: who may call them, every
// reason a booking is refused, holds, rescheduling, capacity, prices, and two customers racing
// for one slot. Most checks run in a rolled-back transaction; the race needs two connections
// and commits, so it uses an evening slot no other test touches.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001";
const BARBER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001";
const COLOUR = "c1000000-0000-4000-8000-000000000002";
const MEN_CUT = "c2000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const BEE = "a1000000-0000-4000-8000-000000000002";
const PLOY = "a1000000-0000-4000-8000-000000000003";
const TONG = "a2000000-0000-4000-8000-000000000001";
const AKE = "a2000000-0000-4000-8000-000000000002";

const OWNER_SALON = "f1000000-0000-4000-8000-00000000000a";
const OWNER_BARBER = "f2000000-0000-4000-8000-00000000000a";

const CUSTOMER = JSON.stringify({ name: "คุณทดสอบ", phone: "0800000000" });

let db;

// A day `ahead` days from today in Bangkok, optionally the first one on a given weekday
function bangkokDay(ahead, weekday) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  if (weekday !== undefined) while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (day, time) => `${day}T${time}:00+07:00`;
const DAY = bangkokDay(3, 2); // a Tuesday: everyone works, both shops open
const WEDNESDAY = bangkokDay(3, 3); // ช่างบี is off

test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'salon@test.local'), ($2, 'barber@test.local') on conflict do nothing", [OWNER_SALON, OWNER_BARBER]);
  await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner') on conflict do nothing", [SALON, OWNER_SALON, BARBER, OWNER_BARBER]);
});

test.after(async () => {
  if (db) await db.end();
});

async function as(role, userId, fn, client = db) {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    if (userId) await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

function book({ shop = SALON, offering = CUT, start, resource = null, duration = null, party = 1, hold = false, source = "web", customer = CUSTOMER }) {
  return one(
    "select public.create_booking($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) as b",
    [shop, offering, start, customer, resource, duration, party, hold, source]
  ).then((r) => r.b);
}

/** Expects a booking error with this SQLSTATE and reason, inside a savepoint. */
async function refused(promiseFn, code, reason) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(promiseFn(), (err) => {
      assert.equal(err.code, code, `${err.code} ${err.message}`);
      if (reason) assert.equal(err.message, reason);
      return true;
    });
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("anon cannot call any booking function", { skip }, async () => {
  for (const sql of [
    `select public.create_booking('${SALON}', '${CUT}', now() + interval '2 days', '{"name":"x"}')`,
    `select public.cancel_booking(gen_random_uuid())`,
    `select public.expire_holds()`,
    `select public.booking_plan('${SALON}', '${CUT}', now(), null, null, 1, null, false)`
  ]) {
    await as("anon", null, async () => {
      await refused(() => db.query(sql), "42501");
    });
  }
});

test("a signed-in owner can book only in their own shop", { skip }, async () => {
  await as("authenticated", OWNER_BARBER, async () => {
    await refused(() => book({ start: at(DAY, "11:00"), resource: NAN }), "42501");
  });
  await as("authenticated", OWNER_SALON, async () => {
    const b = await book({ start: at(DAY, "11:00"), resource: NAN });
    assert.equal(b.status, "confirmed");
  });
});

test("a booking takes the stylist, the length, the price and starts its history", { skip }, async () => {
  await as("service_role", null, async () => {
    const b = await book({ start: at(DAY, "11:00"), resource: NAN });
    assert.equal(b.status, "confirmed");
    assert.equal(new Date(b.end_at).getTime() - new Date(b.start_at).getTime(), 60 * 60000);
    assert.deepEqual(b.resources, [{ resource_id: NAN, units: 1 }]);
    assert.equal(b.price.total, 450);
    const range = await one("select upper(range) - lower(range) as length from public.booking_resources where booking_id = $1", [b.id]);
    assert.equal(range.length.minutes, 10, "the stylist is held 60 minutes plus the 10-minute buffer");
    assert.equal(range.length.hours, 1);
    const history = await one("select from_status, to_status from public.booking_status_history where booking_id = $1", [b.id]);
    assert.deepEqual(history, { from_status: null, to_status: "confirmed" });
    // the same customer (by phone) is reused next time
    const again = await book({ start: at(DAY, "14:00"), resource: NAN });
    assert.equal(again.customer_id, b.customer_id);
  });
});

test("every refusal says why", { skip }, async () => {
  await as("service_role", null, async () => {
    await refused(() => book({ start: at(DAY, "11:00"), resource: PLOY }), "BK422", "NOT_OFFERED"); // colour only
    await refused(() => book({ start: at(WEDNESDAY, "11:00"), resource: BEE }), "BK422", "STAFF_OFF");
    await refused(() => book({ start: at(DAY, "19:30"), resource: NAN }), "BK422", "NO_WORKING_WINDOW"); // ends after 20:00
    await refused(() => book({ start: at(DAY, "11:05"), resource: NAN }), "BK422", "INVALID_TIME"); // off the 15-minute grid
    await refused(() => book({ start: at(bangkokDay(60), "11:00"), resource: NAN }), "BK422", "OUTSIDE_BOOKING_WINDOW");
    await refused(() => book({ start: new Date(Date.now() - 3600000).toISOString(), resource: NAN }), "BK422", "OUTSIDE_BOOKING_WINDOW");
    await refused(() => book({ start: new Date(Date.now() + 5 * 60000).toISOString(), resource: NAN }), "BK422", "PAST_WORKING_HOURS");
    await refused(() => book({ start: at(DAY, "11:00"), resource: NAN, duration: 90 }), "BK422", "INVALID_DURATION");
    await refused(() => book({ start: at(DAY, "11:00"), resource: NAN, party: 2 }), "BK422", "INVALID_PARTY_SIZE");
    await refused(() => book({ start: at(DAY, "11:00"), resource: NAN, customer: "{}" }), "BK422", "CUSTOMER_NAME_REQUIRED");
    await refused(() => book({ shop: BARBER, offering: CUT, start: at(DAY, "11:00") }), "BK422", "NOT_OFFERED"); // another shop's offering
    await refused(() => book({ shop: BARBER, offering: MEN_CUT, start: at(bangkokDay(3, 1), "11:00") }), "BK422", "BUSINESS_CLOSED"); // Monday

    await db.query("insert into public.business_closures (business_id, date) values ($1, $2)", [SALON, DAY]);
    await refused(() => book({ start: at(DAY, "11:00"), resource: NAN }), "BK422", "BUSINESS_CLOSED");
  });
});

test("an admin booking may skip the grid", { skip }, async () => {
  await as("service_role", null, async () => {
    const b = await book({ start: at(DAY, "11:05"), resource: NAN, source: "admin" });
    assert.equal(b.status, "confirmed");
  });
});

test("each booking keeps the name typed for it, even when the phone number is shared", { skip }, async () => {
  await as("service_role", null, async () => {
    const first = await book({ start: at(DAY, "11:00"), resource: NAN, customer: JSON.stringify({ name: "คุณแม่", phone: "0811111111" }) });
    const second = await book({ start: at(DAY, "14:00"), resource: NAN, customer: JSON.stringify({ name: "น้องลูก", phone: "0811111111" }) });
    const names = (await db.query("select id, customer_id, customer_name from public.bookings where id = any($1)", [[first.id, second.id]])).rows;
    assert.equal(names.find((r) => r.id === first.id).customer_name, "คุณแม่");
    assert.equal(names.find((r) => r.id === second.id).customer_name, "น้องลูก");
    assert.equal(names[0].customer_id, names[1].customer_id, "still one customer record per phone number");
  });
});

test("\"anyone\" takes the first free barber, then the other, then the slot is full", { skip }, async () => {
  await as("service_role", null, async () => {
    const first = await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "10:00") });
    const second = await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "10:00") });
    assert.deepEqual([first.resources[0].resource_id, second.resources[0].resource_id], [TONG, AKE]);
    await refused(() => book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "10:00") }), "BK409", "FULLY_BOOKED");
    // the 5-minute buffer still blocks 10:30
    await refused(() => book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "10:30") }), "BK409", "FULLY_BOOKED");
    assert.equal((await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "10:45") })).status, "confirmed");
  });
});

test("prices follow the rules: evening price at the barber, per-hour across a price change", { skip }, async () => {
  await as("service_role", null, async () => {
    assert.equal((await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "11:00") })).price.total, 200);
    assert.equal((await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "17:00") })).price.total, 250);

    const { id: offering } = await one(
      "insert into public.offerings (business_id, name, duration_mode, min_minutes, max_minutes, step_minutes) values ($1, 'เช่าห้อง', 'customer_choice', 60, 180, 60) returning id",
      [SALON]
    );
    await db.query(
      `insert into public.price_rules (business_id, offering_id, unit, amount, start_time, end_time, priority) values
         ($1, $2, 'per_hour', 300, null, null, 0), ($1, $2, 'per_hour', 450, '17:00', '23:00', 1)`,
      [SALON, offering]
    );
    const price = await one("select public.booking_price($1, $2, $3, 1, 'Asia/Bangkok') as p", [offering, at(DAY, "16:00"), at(DAY, "18:00")]);
    assert.equal(price.p.total, 750);
  });
});

test("a hold keeps the slot until it runs out, then anyone can take it", { skip }, async () => {
  await as("service_role", null, async () => {
    const held = await book({ start: at(DAY, "15:00"), resource: NAN, hold: true });
    assert.equal(held.status, "held");
    assert.ok(new Date(held.hold_expires_at) > new Date());
    await refused(() => book({ start: at(DAY, "15:00"), resource: NAN }), "BK409", "FULLY_BOOKED");

    // the customer pays in time
    const paid = await one("select public.confirm_booking($1) as b", [held.id]);
    assert.equal(paid.b.status, "confirmed");
    assert.equal(paid.b.hold_expires_at, null);

    // another hold that runs out
    const late = await book({ start: at(DAY, "17:00"), resource: NAN, hold: true });
    await db.query("update public.bookings set hold_expires_at = now() - interval '1 second' where id = $1", [late.id]);
    await refused(() => db.query("select public.confirm_booking($1)", [late.id]), "BK409", "HOLD_EXPIRED");
    const taker = await book({ start: at(DAY, "17:00"), resource: NAN });
    assert.equal(taker.status, "confirmed");
    const old = await one("select status, hold_expires_at from public.bookings where id = $1", [late.id]);
    assert.deepEqual(old, { status: "expired", hold_expires_at: null });
    const reason = await one("select reason from public.booking_status_history where booking_id = $1 and to_status = 'expired'", [late.id]);
    assert.equal(reason.reason, "hold expired");
  });
});

test("rescheduling may overlap its own old time but not someone else's", { skip }, async () => {
  await as("service_role", null, async () => {
    const mine = await book({ start: at(DAY, "11:00"), resource: NAN });
    await book({ start: at(DAY, "13:00"), resource: NAN });
    const moved = await one("select public.reschedule_booking($1, $2) as b", [mine.id, at(DAY, "11:30")]);
    assert.equal(moved.b.start_at.slice(11, 16), "04:30"); // 11:30 in Bangkok, in UTC
    assert.deepEqual(moved.b.resources, [{ resource_id: NAN, units: 1 }]);
    // the customer chose ช่างแนน, so a move keeps her even though ช่างบี is free at 12:30
    await refused(() => db.query("select public.reschedule_booking($1, $2)", [mine.id, at(DAY, "12:30")]), "BK409", "FULLY_BOOKED");
    // moving to another stylist on purpose
    const other = await one("select public.reschedule_booking($1, $2, $3) as b", [mine.id, at(DAY, "13:00"), BEE]);
    assert.deepEqual(other.b.resources, [{ resource_id: BEE, units: 1 }]);

    // at the barber the shop assigns barbers, so a move may switch to whoever is free
    const cut = await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "11:00") });
    await book({ shop: BARBER, offering: MEN_CUT, start: at(DAY, "12:00") });
    const switched = await one("select public.reschedule_booking($1, $2) as b", [cut.id, at(DAY, "12:00")]);
    assert.deepEqual(switched.b.resources, [{ resource_id: AKE, units: 1 }]);
  });
});

test("cancelling frees the slot, records why, and is safe to repeat", { skip }, async () => {
  await as("service_role", null, async () => {
    const b = await book({ start: at(DAY, "16:00"), resource: NAN });
    const cancelled = await one("select public.cancel_booking($1, 'ลูกค้าติดธุระ') as b", [b.id]);
    assert.equal(cancelled.b.status, "cancelled");
    assert.deepEqual(cancelled.b.resources, []);
    assert.equal((await one("select public.cancel_booking($1) as b", [b.id])).b.status, "cancelled");
    const reason = await one("select reason from public.booking_status_history where booking_id = $1 and to_status = 'cancelled'", [b.id]);
    assert.equal(reason.reason, "ลูกค้าติดธุระ");
    assert.equal((await book({ start: at(DAY, "16:00"), resource: NAN })).status, "confirmed");
    await refused(() => db.query("select public.reschedule_booking($1, $2)", [b.id, at(DAY, "18:00")]), "BK422", "NOT_CHANGEABLE");
  });
});

test("a class of 12 takes 12 people and refuses the 13th", { skip }, async () => {
  await as("service_role", null, async () => {
    const { id: room } = await one("insert into public.resources (business_id, kind, name, capacity) values ($1, 'room', 'ห้องโยคะ', 12) returning id", [SALON]);
    const { id: yoga } = await one(
      "insert into public.offerings (business_id, name, duration_minutes, max_party_size) values ($1, 'โยคะ', 60, 12) returning id",
      [SALON]
    );
    await db.query("insert into public.offering_requirements (business_id, offering_id, kind, units_per_booking) values ($1, $2, 'room', 'party_size')", [SALON, yoga]);
    await db.query("insert into public.offering_resources (business_id, offering_id, resource_id) values ($1, $2, $3)", [SALON, yoga, room]);

    await book({ offering: yoga, start: at(DAY, "18:00"), party: 5 });
    for (let i = 0; i < 6; i++) await book({ offering: yoga, start: at(DAY, "18:00"), customer: JSON.stringify({ name: `คนที่ ${i}` }) });
    await refused(() => book({ offering: yoga, start: at(DAY, "18:00"), party: 2 }), "BK409", "FULLY_BOOKED"); // 11 + 2
    await book({ offering: yoga, start: at(DAY, "18:00") }); // the 12th
    await refused(() => book({ offering: yoga, start: at(DAY, "18:00") }), "BK409", "FULLY_BOOKED"); // the 13th
    // a class that starts halfway through overlaps the full one
    await refused(() => book({ offering: yoga, start: at(DAY, "18:30"), resource: room }), "BK409", "FULLY_BOOKED");
    assert.equal((await book({ offering: yoga, start: at(DAY, "19:00"), party: 12 })).status, "confirmed");
  });
});

test("two customers pressing book at the same moment: one gets the slot, the other a conflict", { skip }, async () => {
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect();
  await b.connect();
  const day = bangkokDay(5, 4); // a Thursday, evening: no other test books it
  const call = (client, name) =>
    client.query("select public.create_booking($1, $2, $3, $4::jsonb, $5) as b", [SALON, CUT, at(day, "18:45"), JSON.stringify({ name }), NAN]);
  try {
    await a.query("begin");
    await b.query("begin");
    const first = await call(a, "ลูกค้า A");
    // B waits on A's lock on the stylist ...
    const second = call(b, "ลูกค้า B").then(
      () => null,
      (err) => err
    );
    await new Promise((r) => setTimeout(r, 300));
    await a.query("commit");
    // ... and once A commits, B sees A's booking
    const err = await second;
    await b.query("rollback");
    assert.equal(first.rows[0].b.status, "confirmed");
    assert.ok(err, "the second booking must be refused");
    assert.equal(err.code, "BK409");
    assert.equal(err.message, "FULLY_BOOKED");
  } finally {
    await db.query("delete from public.bookings where id in (select booking_id from public.booking_resources where resource_id = $1 and lower(range) = $2)", [NAN, at(day, "18:45")]);
    await a.end();
    await b.end();
  }
});
