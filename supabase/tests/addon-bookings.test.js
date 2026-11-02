// Bookings with add-ons (migration …002100, design §11 steps B–C) against the test database:
// the public API books as the customer, the shop works as a signed-in member, in rolled-back
// transactions. The salon gets a rack of 3 rentable rackets to stand in for a sports shop's gear.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const bookings = require("../../src/v2/admin-bookings");
const { book, step, shopInfo } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const CUT = "c1000000-0000-4000-8000-000000000001"; // 60 min, 450
const COLOUR = "c1000000-0000-4000-8000-000000000002";
const NAN = "a1000000-0000-4000-8000-000000000001";
const BEE = "a1000000-0000-4000-8000-000000000002";
const OWNER = { id: "e8300000-0000-4000-8000-00000000000a", email: "owner@addon-bookings.test" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokTuesday(3);

async function asCustomer() {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
}

async function asOwner() {
  await db.query("reset role");
  await admin.actAs(db, OWNER);
  return admin.memberShop(db, "bloom-hair");
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

// The shop sets up its extras; returns the add-on ids
async function inTx(fn, { min = 0 } = {}) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) values ($1, $2)", [OWNER.id, OWNER.email]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')", [SALON, OWNER.id]);
    const shop = await asOwner();
    await admin.saveResource(db, shop, null, { kind: "ไม้แบด", name: "ไม้แบด", capacity: 3 });
    await admin.saveAddonGroup(db, shop, null, {
      name: "อุปกรณ์", offeringIds: [CUT],
      addons: [{ name: "เช่าไม้", priceUnit: "per_unit", amount: 50, maxQuantity: 4, usesKind: "ไม้แบด" }]
    });
    await admin.saveAddonGroup(db, shop, null, {
      name: "บริการเสริม", minSelect: min, maxSelect: 1, offeringIds: [CUT],
      addons: [{ name: "ห้องอาบน้ำ", amount: 150 }, { name: "ทรีตเมนต์เพิ่ม", amount: 300, addsMinutes: 30 }]
    });
    const groups = (await admin.getCatalog(db, shop)).addonGroups;
    const id = (name) => groups.flatMap((g) => g.addons).find((a) => a.name === name).id;
    await asCustomer();
    return await fn({ racket: id("เช่าไม้"), shower: id("ห้องอาบน้ำ"), treatment: id("ทรีตเมนต์เพิ่ม") });
  } finally {
    await db.query("rollback");
  }
}

const customer = (name) => ({ name, phone: "0812345678" });
const at = (time, resourceId, addons, offeringId = CUT) => ({ selected: { offeringId, resourceId, date: DAY, time, addons } });

test("the page asks for add-ons after the time, then the booking holds the rackets and prices every line", { skip }, async () => {
  await inTx(async ({ racket, shower }) => {
    const info = await shopInfo(db, "bloom-hair");
    assert.deepEqual(info.addonGroups.map((g) => [g.name, g.offeringIds, g.addons.map((a) => a.name)]), [
      ["บริการเสริม", [CUT], ["ห้องอาบน้ำ", "ทรีตเมนต์เพิ่ม"]],
      ["อุปกรณ์", [CUT], ["เช่าไม้"]]
    ]);

    const next = await step(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: DAY, time: "11:00" }, changed: "time" });
    assert.equal(next.ask, "addons");
    assert.deepEqual(next.groups.map((g) => g.name), ["บริการเสริม", "อุปกรณ์"]);
    assert.deepEqual(next.options.find((o) => o.value === racket).maxQuantity, 3);
    await refused(() => book(db, "bloom-hair", { ...at("11:00", NAN), customer: customer("ยังไม่ตอบ") }), (e) => e.status === 422 && e.details.step === "addons");

    const made = await book(db, "bloom-hair", { ...at("11:00", NAN, { [racket]: 2, [shower]: 1 }), customer: customer("เช่าไม้ 2") });
    assert.equal(made.price.total, 700); // 450 + 2 × 50 + 150
    assert.deepEqual(made.price.lines.map((l) => [l.kind, l.name, l.quantity ?? null, l.total]), [
      ["offering", "ตัดผมหญิง + สระไดร์", null, 450],
      ["addon", "ห้องอาบน้ำ", 1, 150],
      ["addon", "เช่าไม้", 2, 100]
    ]);
    assert.deepEqual(made.addons.map((a) => [a.name, a.quantity, a.total]).sort(), [["ห้องอาบน้ำ", 1, 150], ["เช่าไม้", 2, 100]]);
    assert.deepEqual(made.resources.map((r) => r.name), ["ช่างแนน"], "the rackets are not shown as the stylist");
    const { rows } = await db.query(
      "select r.kind, br.units, br.addon_id from public.booking_resources br join public.resources r on r.id = br.resource_id where br.booking_id = $1 order by r.kind",
      [made.id]
    );
    assert.deepEqual(rows.map((r) => [r.kind, r.units, r.addon_id]), [["staff", 1, null], ["ไม้แบด", 2, racket]]);

    // one racket left at 11:00: another customer can rent one, not two
    await refused(() => book(db, "bloom-hair", { ...at("11:00", BEE, { [racket]: 2 }), customer: customer("ไม่พอ") }), (e) => e.status === 409 && e.details.reason === "ADDON_UNAVAILABLE");
    const last = await book(db, "bloom-hair", { ...at("11:00", BEE, { [racket]: 1 }), customer: customer("อันสุดท้าย") });
    assert.equal(last.price.total, 500);

    // the shop sees the add-ons on the booking card, and the customer on their link
    const listed = (await bookings.listBookings(db, await asOwner(), { from: DAY })).find((b) => b.id === made.id);
    assert.deepEqual(listed.addons.map((a) => a.name).sort(), ["ห้องอาบน้ำ", "เช่าไม้"]);
    assert.deepEqual(listed.resources.map((r) => r.name), ["ช่างแนน"]);
    await asCustomer();
    const mine = await manage.findManaged(db, "bloom-hair", made.manageToken);
    assert.deepEqual(mine.booking.addons.map((a) => [a.name, a.quantity]).sort(), [["ห้องอาบน้ำ", 1], ["เช่าไม้", 2]]);
  });
});

test("extra minutes lengthen the booking: the stylist stays busy and the next slot moves", { skip }, async () => {
  await inTx(async ({ treatment }) => {
    const longer = await book(db, "bloom-hair", { ...at("11:00", NAN, { [treatment]: 1 }), customer: customer("ทำเพิ่ม") });
    assert.equal((new Date(longer.endAt) - new Date(longer.startAt)) / 60000, 90);
    assert.equal(longer.price.total, 750);
    // 11:00 + 90 minutes + the 10-minute clean-up: 12:30 is still taken, 12:45 is free
    await refused(() => book(db, "bloom-hair", { ...at("12:30", NAN, {}), customer: customer("ชนเวลา") }), (e) => e.status === 409);
    const after = await book(db, "bloom-hair", { ...at("12:45", NAN, {}), customer: customer("ต่อคิว") });
    assert.equal(after.price.total, 450);
    assert.equal(after.price.lines, undefined, "no add-ons, no lines: the snapshot looks as before");
  });
});

test("the shop's rules hold in the database: group maximum and minimum, other offerings, unknown ids", { skip }, async () => {
  await inTx(async ({ racket, shower, treatment }) => {
    await refused(() => book(db, "bloom-hair", { ...at("11:00", NAN, { [shower]: 1, [treatment]: 1 }), customer: customer("สองอย่าง") }), (e) => e.status === 422);
    // straight to the RPC: the page cannot sneak past the engine either
    const call = (addons, offering = CUT) =>
      db.query(
        `select public.create_booking($1, $2, ($3 || ' 11:00+07')::timestamptz, '{"name":"ตรง"}'::jsonb, $4, null, 1, false, 'web', null, $5::jsonb)`,
        [SALON, offering, DAY, NAN, JSON.stringify(addons)]
      );
    await refused(() => call({ [shower]: 1, [treatment]: 1 }), (e) => e.code === "BK422" && e.message === "ADDON_GROUP_RULE");
    await refused(() => call({ [racket]: 5 }), (e) => e.code === "BK422" && e.message === "ADDON_INVALID");
    await refused(() => call({ [racket]: 1 }, COLOUR), (e) => e.code === "BK422" && e.message === "ADDON_INVALID");
    await refused(() => call({ "f2000000-0000-4000-8000-0000000000ff": 1 }), (e) => e.code === "BK422" && e.message === "ADDON_INVALID");
    await refused(() => call({ [racket]: "2" }), (e) => e.code === "BK422" && e.message === "ADDON_INVALID");
  });
  await inTx(async ({ shower }) => {
    await refused(() => book(db, "bloom-hair", { ...at("11:00", NAN, {}), customer: customer("ต้องเลือก") }), (e) => e.status === 422);
    await book(db, "bloom-hair", { ...at("11:00", NAN, { [shower]: 1 }), customer: customer("เลือกแล้ว") });
    // the shop's own booking may skip a group's minimum
    const desk = await bookings.createBooking(db, await asOwner(), { offeringId: CUT, resourceId: BEE, date: DAY, time: "11:00", customer: { name: "โทรมา" } });
    assert.ok(desk.id);
  }, { min: 1 });
});

test("moving a booking takes its add-ons along: rackets are picked again, and must be free", { skip }, async () => {
  await inTx(async ({ racket }) => {
    const made = await book(db, "bloom-hair", { ...at("11:00", NAN, { [racket]: 2 }), customer: customer("ย้าย") });
    await book(db, "bloom-hair", { ...at("14:00", BEE, { [racket]: 2 }), customer: customer("จองไม้ไว้ก่อน") });
    await refused(
      () => manage.rescheduleManaged(db, "bloom-hair", made.manageToken, { date: DAY, time: "14:00" }),
      (e) => e.status === 409 && e.details.reason === "ADDON_UNAVAILABLE"
    );
    // the customer's own options already leave out 14:00 (the rackets are out until 15:10) but keep 15:15
    const times = (await manage.manageOptions(db, "bloom-hair", made.manageToken, { ask: "time", date: DAY })).options.map((o) => o.value);
    assert.ok(!times.includes("14:00") && !times.includes("15:00") && times.includes("15:15"));
    await manage.rescheduleManaged(db, "bloom-hair", made.manageToken, { date: DAY, time: "15:15" });
    const { rows } = await db.query(
      "select (select sum(units) from public.booking_resources where booking_id = b.id and addon_id is not null) as rackets, (b.price_snapshot->>'total')::float8 as total from public.bookings b where b.id = $1",
      [made.id]
    );
    assert.deepEqual(rows[0], { rackets: "2", total: 550 });
  });
});

test("a branch copied from this shop gets its add-on groups, linked to the copied offerings", { skip }, async () => {
  await inTx(async () => {
    await db.query("reset role");
    const { rows: [brand] } = await db.query("select brand_id from public.businesses where id = $1", [SALON]);
    await db.query("update public.brand_plans set plan = 'pro', valid_until = null where brand_id = $1", [brand.brand_id]);
    const { rows: [made] } = await db.query("select public.add_branch($1, 'Bloom สาขา 2', 'bloom-two', $2, true) as id", [brand.brand_id, SALON]);
    const { rows } = await db.query(
      `select g.name, g.min_select, g.max_select, count(distinct a.id)::int as addons, count(distinct l.offering_id)::int as offerings
         from public.addon_groups g left join public.addons a on a.group_id = g.id
         left join public.offering_addon_groups l on l.group_id = g.id
        where g.business_id = $1 group by g.name, g.min_select, g.max_select order by g.name`,
      [made.id]
    );
    assert.deepEqual(rows, [
      { name: "บริการเสริม", min_select: 0, max_select: 1, addons: 2, offerings: 1 },
      { name: "อุปกรณ์", min_select: 0, max_select: null, addons: 1, offerings: 1 }
    ]);
  });
});
