// The shop admin (src/v2/admin-catalog.js, design step 5) against the test database, run as the
// signed-in user exactly as app/api/dashboard/* does (role authenticated + the user's id), inside
// rolled-back transactions. Users and memberships are created inside each transaction too.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { step, book } = require("../../src/v2/public-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SHOP_A = "b1000000-0000-4000-8000-000000000001"; // bloom-hair
const SHOP_B = "b2000000-0000-4000-8000-000000000002"; // gentleman-barber
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";

const USERS = {
  ownerA: { id: "e3000000-0000-4000-8000-00000000000a", email: "owner-a@test.local" },
  staffA: { id: "e3000000-0000-4000-8000-00000000000b", email: "staff-a@test.local" },
  ownerB: { id: "e3000000-0000-4000-8000-00000000000c", email: "owner-b@test.local" },
  newcomer: { id: "e3000000-0000-4000-8000-00000000000d", email: "new@test.local" }
};

let db;

test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

function bangkokDay(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}

/** fn() as `user`, in a transaction that is rolled back; the demo users and memberships exist only inside it. */
async function as(user, fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query(
      "insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SHOP_A, SHOP_B, USERS.ownerA.id, USERS.staffA.id, USERS.ownerB.id]
    );
    await admin.actAs(db, user);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

// An expected failure, rolled back to a savepoint so the transaction stays usable
async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(async () => {
      try {
        await fn();
      } catch (error) {
        throw admin.dbError(error);
      }
    }, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("members see their own shops only; staff read, owners write", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    assert.deepEqual(await admin.listShops(db), [{ slug: "bloom-hair", name: "Bloom Hair & Beauty", kind: "salon", role: "owner" }]);
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const catalog = await admin.getCatalog(db, shop);
    assert.equal(catalog.shop.role, "owner");
    assert.deepEqual(catalog.offerings.map((o) => [o.name, o.prices[0].amount]), [
      ["ตัดผมหญิง + สระไดร์", 450],
      ["ทำสีผม", 1500],
      ["ทรีตเมนต์บำรุงผม", 600]
    ]);
    assert.deepEqual(catalog.offerings[0].requirements, [{ kind: "staff", customerPicks: true, unitsPerBooking: "one" }]);
    assert.equal(catalog.resources.length, 3);
    assert.deepEqual(catalog.resources[1].schedule[3], { dayOfWeek: 3, isWorking: false, start: "10:00", end: "20:00", custom: true });
    assert.deepEqual(catalog.flow.entry, ["date", "offering"]);
    assert.equal(catalog.flow.options.showAnyStaff, true);
    await refused(() => admin.memberShop(db, "gentleman-barber"), (e) => e.status === 404);
    await refused(() => admin.memberShop(db, "../x"), (e) => e.status === 404);
  });

  await as(USERS.staffA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair");
    assert.equal((await admin.getCatalog(db, shop)).shop.role, "staff");
    await refused(() => admin.memberShop(db, "bloom-hair", { owner: true }), (e) => e.status === 403);
    // even past the role check, the database refuses a staff member's write
    await refused(() => admin.saveResource(db, shop, null, { kind: "staff", name: "ช่างใหม่" }), (e) => e.status === 403);
  });
});

test("an owner cannot write into another shop, even by passing its id", { skip }, async () => {
  await as(USERS.ownerB, async () => {
    const fake = { id: SHOP_A, slug: "bloom-hair", kind: "salon" };
    await refused(() => admin.saveResource(db, fake, null, { kind: "staff", name: "แอบเพิ่ม" }), (e) => e.status === 403);
    await refused(() => admin.saveOffering(db, fake, CUT, { name: "แอบแก้", durationMinutes: 30 }), (e) => e.status === 404);
    await refused(() => admin.deleteResource(db, fake, NAN), (e) => e.status === 404);
    await refused(() => admin.saveFlow(db, fake, { entry: ["offering"], require: ["offering", "date", "time"] }), (e) => e.status === 403);
    // pointing its own offering at shop A's stylist
    const own = await admin.memberShop(db, "gentleman-barber", { owner: true });
    await refused(
      () => admin.saveOffering(db, own, null, { name: "ข้ามร้าน", durationMinutes: 30, resourceIds: [NAN] }),
      (e) => e.status === 422 || e.status === 403
    );
  });
  const name = (await db.query("select name from public.offerings where id = $1", [CUT])).rows[0].name;
  assert.equal(name, "ตัดผมหญิง + สระไดร์");
});

test("a new owner sets up a football court shop without code, and customers can book it", { skip }, async () => {
  await as(USERS.newcomer, async () => {
    assert.deepEqual(await admin.createShop(db, { name: "สนามฟุตบอลบ้านสวน", slug: "Baan-Suan-FC", kind: "court" }), { slug: "baan-suan-fc" });
    await refused(() => admin.createShop(db, { name: "ซ้ำ", slug: "bloom-hair" }), (e) => e.status === 409);
    const shop = await admin.memberShop(db, "baan-suan-fc", { owner: true });
    let catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.hours[0], { dayOfWeek: 0, isOpen: true, open: "10:00", close: "19:00" }, "a new shop starts with hours");

    await admin.saveShop(db, shop, {
      name: "สนามฟุตบอลบ้านสวน",
      kind: "court",
      settings: { minLeadMinutes: 0, slotIntervalMinutes: 60, maxAdvanceDays: 14, holdMinutes: 10 },
      hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, isOpen: true, open: "08:00", close: "23:00" }))
    });
    const court1 = (await admin.saveResource(db, shop, null, { kind: "court", name: "สนาม 1 (หญ้าเทียม)", sortOrder: 1 })).id;
    const court2 = (await admin.saveResource(db, shop, null, { kind: "court", name: "สนาม 2", sortOrder: 2 })).id;
    const rental = (await admin.saveOffering(db, shop, null, {
      name: "เช่าสนามฟุตบอล 7 คน",
      durationMode: "customer_choice",
      minMinutes: 60,
      maxMinutes: 180,
      stepMinutes: 60,
      requirements: [{ kind: "court", customerPicks: true }],
      resourceIds: [court1, court2],
      prices: [
        { unit: "per_hour", amount: 300 },
        { unit: "per_hour", amount: 450, start: "17:00", end: "23:00" }
      ]
    })).id;
    await admin.saveFlow(db, shop, {
      entry: ["resource"],
      require: ["offering", "resource", "date", "time", "duration"],
      optional: [],
      then: ["customer"],
      options: { dateRangeDays: 7, showAnyStaff: false }
    });

    catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.offerings[0].prices.map((p) => [p.amount, p.start, p.priority]), [[300, null, 0], [450, "17:00", 1]]);
    assert.deepEqual(catalog.flow.entry, ["resource"]);

    // the public booking page, as a customer (no signed-in user)
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
    const day = bangkokDay(2);
    let s = await step(db, "baan-suan-fc", { selected: {} });
    assert.deepEqual(s.next, { step: "resource" }, "one way in: straight to the courts");
    assert.deepEqual(s.options.map((o) => o.label), ["สนาม 1 (หญ้าเทียม)", "สนาม 2"]);
    s = await step(db, "baan-suan-fc", { selected: { resourceId: court2 }, changed: "resource" });
    assert.equal(s.ask, "offering");
    s = await step(db, "baan-suan-fc", { selected: { ...s.selected, offeringId: rental }, changed: "offering" });
    assert.equal(s.ask, "date");
    assert.equal(s.options.length, 8);
    s = await step(db, "baan-suan-fc", { selected: { ...s.selected, date: day }, changed: "date" });
    assert.equal(s.ask, "time");
    s = await step(db, "baan-suan-fc", { selected: { ...s.selected, time: "16:00" }, changed: "time" });
    assert.equal(s.ask, "duration");
    assert.deepEqual(s.options.map((o) => o.value), [60, 120, 180]);
    s = await step(db, "baan-suan-fc", { selected: { ...s.selected, durationMinutes: 120 }, changed: "duration" });
    assert.deepEqual(s.next, { step: "customer" });

    const b = await book(db, "baan-suan-fc", { selected: s.selected, customer: { name: "ทีมบ้านสวน", phone: "0811111111" } });
    assert.equal(b.status, "confirmed");
    assert.deepEqual(b.resources.map((r) => r.name), ["สนาม 2"]);
    assert.equal(b.price.total, 750, "16:00–17:00 at 300 + 17:00–18:00 at 450");

    // back as the owner: a booked court or offering is switched off, an unused one is deleted
    await admin.actAs(db, USERS.newcomer);
    assert.deepEqual(await admin.deleteResource(db, shop, court2), { removed: false, archived: true });
    assert.deepEqual(await admin.deleteResource(db, shop, court1), { removed: true, archived: false });
    assert.deepEqual(await admin.deleteOffering(db, shop, rental), { removed: false, archived: true });
    catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.resources.map((r) => [r.name, r.active]), [["สนาม 2", false]]);
    assert.equal(catalog.offerings[0].active, false);
  });
});

test("resources: weekly schedule, offerings they do, and days off", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const schedule = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      d === 1 ? { dayOfWeek: 1, isWorking: false, custom: true } : d === 2 ? { dayOfWeek: 2, isWorking: true, start: "12:00", end: "18:00", custom: true } : { dayOfWeek: d, custom: false }
    );
    const id = (await admin.saveResource(db, shop, null, { kind: "staff", name: "ช่างมิว", schedule, offeringIds: [CUT] })).id;
    let r = (await admin.getCatalog(db, shop)).resources.find((x) => x.id === id);
    assert.deepEqual(r.schedule.slice(0, 3), [
      { dayOfWeek: 0, isWorking: true, start: null, end: null, custom: false },
      { dayOfWeek: 1, isWorking: false, start: "00:00", end: "23:59", custom: true },
      { dayOfWeek: 2, isWorking: true, start: "12:00", end: "18:00", custom: true }
    ]);
    assert.deepEqual(r.offeringIds, [CUT]);

    await admin.saveResource(db, shop, id, { kind: "staff", name: "ช่างมิว", offeringIds: [] });
    r = (await admin.getCatalog(db, shop)).resources.find((x) => x.id === id);
    assert.deepEqual(r.offeringIds, []);
    assert.equal(r.schedule[1].custom, true, "schedule left alone when not sent");

    const day = bangkokDay(5);
    const off = await admin.addTimeOff(db, shop, { resourceId: id, date: day, isFullDay: false, start: "13:00", end: "15:00", reason: "หาหมอ" });
    const closure = await admin.addClosure(db, shop, { date: day, reason: "สงกรานต์" });
    let catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.timeOff.map((t) => [t.date, t.start, t.end, t.reason]), [[day, "13:00", "15:00", "หาหมอ"]]);
    assert.deepEqual(catalog.closures.map((c) => [c.date, c.isFullDay]), [[day, true]]);
    await admin.deleteTimeOff(db, shop, off.id);
    await admin.deleteClosure(db, shop, closure.id);
    catalog = await admin.getCatalog(db, shop);
    assert.equal(catalog.timeOff.length + catalog.closures.length, 0);

    await refused(() => admin.saveResource(db, shop, null, { kind: "x".repeat(41), name: "x" }), (e) => e.status === 422);
    await refused(() => admin.saveResource(db, shop, null, { kind: "  ", name: "x" }), (e) => e.status === 422);
    await refused(() => admin.saveResource(db, shop, null, { kind: "staff", name: " " }), (e) => e.status === 422);
    await refused(() => admin.addClosure(db, shop, { date: day, isFullDay: false, start: "15:00", end: "13:00" }), (e) => e.status === 422);
  });
});

test("opening hours and booking rules are saved and checked", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, isOpen: d !== 1, open: "09:30", close: "18:00" }));
    await admin.saveShop(db, shop, { name: "Bloom Hair", settings: { minLeadMinutes: 60, slotIntervalMinutes: 30, maxAdvanceDays: 60 }, hours });
    const c = await admin.getCatalog(db, shop);
    assert.equal(c.shop.name, "Bloom Hair", "the page reads the new name after a reload");
    assert.deepEqual(c.hours[1], { dayOfWeek: 1, isOpen: false, open: "09:30", close: "18:00" });
    assert.deepEqual(c.settings, { minLeadMinutes: 60, slotIntervalMinutes: 30, maxAdvanceDays: 60, holdMinutes: 10 });

    await refused(() => admin.saveShop(db, shop, { name: "x", hours: hours.slice(0, 6) }), (e) => e.status === 422);
    await refused(() => admin.saveShop(db, shop, { name: "x", hours: hours.map((h) => ({ ...h, close: "09:00" })) }), (e) => e.status === 422);
    await refused(() => admin.saveShop(db, shop, { name: "x", settings: { minLeadMinutes: 0, slotIntervalMinutes: 0, maxAdvanceDays: 1 } }), (e) => e.status === 422);
  });
});

test("offerings: price rules, requirements, and checks", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    await admin.saveOffering(db, shop, CUT, {
      name: "ตัดผมหญิง",
      category: "ตัด",
      durationMinutes: 60,
      bufferAfterMinutes: 10,
      requirements: [{ kind: "staff", customerPicks: true }],
      resourceIds: [NAN],
      prices: [{ unit: "per_booking", amount: 450 }, { unit: "per_booking", amount: 550, daysOfWeek: [0, 6] }]
    });
    const o = (await admin.getCatalog(db, shop)).offerings.find((x) => x.id === CUT);
    assert.equal(o.name, "ตัดผมหญิง");
    assert.deepEqual(o.resourceIds, [NAN]);
    assert.deepEqual(o.prices.map((p) => [p.amount, p.daysOfWeek, p.priority]), [[450, null, 0], [550, [0, 6], 1]]);

    await refused(() => admin.saveOffering(db, shop, null, { name: "x", durationMode: "customer_choice", minMinutes: 60, maxMinutes: 30, stepMinutes: 30 }), (e) => e.status === 422);
    await refused(() => admin.saveOffering(db, shop, null, { name: "x", durationMinutes: 30, requirements: [{ kind: "staff" }, { kind: "staff" }] }), (e) => e.status === 422);
    await refused(() => admin.saveOffering(db, shop, null, { name: "x", durationMinutes: 30, prices: [{ unit: "per_booking", amount: -1 }] }), (e) => e.status === 422);
    await refused(() => admin.saveOffering(db, shop, null, { name: "x", durationMinutes: 30, prices: [{ unit: "per_hour", amount: 1, start: "18:00", end: "17:00" }] }), (e) => e.status === 422);
  });
});

test("booking flow: saved with the page's options, impossible flows refused in words", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    await db.query("update public.booking_flows set options = options || '{\"theme\": \"pink\"}' where business_id = $1", [SHOP_A]);
    await admin.saveFlow(db, shop, { entry: ["offering"], require: ["offering", "date", "time"], optional: ["resource"], then: ["customer"], options: { showAnyStaff: false, dateRangeDays: null } });
    const row = (await db.query("select entry, options from public.booking_flows where business_id = $1", [SHOP_A])).rows[0];
    assert.deepEqual(row, { entry: ["offering"], options: { show_any_staff: false, theme: "pink" } }, "date_range_days removed, other keys kept");

    const bad = [
      [{ entry: ["date"], require: ["date", "time"] }, /บริการ วันที่ และเวลา/],
      [{ entry: ["resource"], require: ["offering", "date", "time"] }, /ทางเริ่ม/],
      [{ entry: [], require: ["offering", "date", "time"] }, /ทางเริ่ม/],
      [{ entry: ["offering"], require: ["offering", "date", "time", "resource"], optional: ["resource"] }, /อย่างใดอย่างหนึ่ง/],
      [{ entry: ["offering"], require: ["offering", "date", "time"], then: ["customer", "payment"] }, /ชำระเงิน/],
      [{ entry: ["offering"], require: ["offering", "date", "time"], then: [] }, /ข้อมูลลูกค้า/],
      [{ entry: ["offering"], require: ["offering", "date", "time", "customer"] }, /ใช้ไม่ได้/]
    ];
    for (const [input, message] of bad) assert.throws(() => admin.checkFlow(input), message);
  });
});

test("a shop names its own kind of resource, and customers pick and book it", { skip }, async () => {
  await as(USERS.ownerA, async () => {
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    const chair = (await admin.saveResource(db, shop, null, { kind: " เก้าอี้นวด ", name: "เก้าอี้ 1" })).id;
    const massage = (await admin.saveOffering(db, shop, null, {
      name: "นวดเท้า",
      durationMinutes: 60,
      requirements: [{ kind: "เก้าอี้นวด", customerPicks: true }],
      resourceIds: [chair],
      prices: [{ unit: "per_booking", amount: 350 }]
    })).id;
    const catalog = await admin.getCatalog(db, shop);
    assert.equal(catalog.resources.find((r) => r.id === chair).kind, "เก้าอี้นวด", "trimmed");
    assert.deepEqual(catalog.offerings.find((o) => o.id === massage).requirements.map((r) => r.kind), ["เก้าอี้นวด"]);

    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)");
    let s = await step(db, "bloom-hair", { selected: { offeringId: massage }, changed: "offering" });
    assert.equal(s.ask, "resource");
    assert.deepEqual(s.options.map((o) => o.label), ["เก้าอี้ 1"]);
    s = await step(db, "bloom-hair", { selected: { offeringId: massage, resourceId: chair, date: bangkokDay(3) }, changed: "date" });
    const b = await book(db, "bloom-hair", { selected: { ...s.selected, time: s.options[0].value }, customer: { name: "ลูกค้านวด", phone: "0822222222" } });
    assert.deepEqual(b.resources.map((r) => r.name), ["เก้าอี้ 1"]);
    assert.equal(b.price.total, 350);
  });
});
