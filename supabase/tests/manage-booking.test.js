// The customer's own booking link (src/v2/manage-booking.js, migration …000900) against the test
// database: the same calls app/api/b/{slug}/manage/{token}/* makes, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const SALON = "b1000000-0000-4000-8000-000000000001";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";

let db;

// A Tuesday at least 3 days ahead (ช่างบี is off on Wednesdays; everyone works Tuesdays)
function bangkokTuesday(ahead) {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + ahead);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = bangkokTuesday(3);

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

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

const bookAt = (time, resourceId = NAN) =>
  book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId, date: DAY, time }, customer: { name: "คุณลิงก์", phone: "0812345678" } });

test("a booking comes with a link; only its hash is stored", { skip }, async () => {
  await inTx(async () => {
    const b = await bookAt("11:00");
    assert.match(b.manageToken, /^[A-Za-z0-9_-]{32}$/);
    const { rows } = await db.query("select manage_token_hash from public.bookings where id = $1", [b.id]);
    assert.equal(rows[0].manage_token_hash, crypto.createHash("sha256").update(b.manageToken).digest("hex"));

    const view = await manage.findManaged(db, "bloom-hair", b.manageToken);
    assert.deepEqual(
      [view.booking.date, view.booking.start, view.booking.end, view.booking.status, view.booking.price, view.booking.offering.name],
      [DAY, "11:00", "12:00", "confirmed", 450, "ตัดผมหญิง + สระไดร์"]
    );
    assert.deepEqual(view.booking.resources, [{ name: "ช่างแนน", kind: "staff" }]);
    assert.equal(view.booking.customerName, "คุณลิงก์");
    assert.equal(view.booking.phone, undefined, "the page never shows the phone number");
    assert.deepEqual([view.cancel.allowed, view.reschedule.allowed, view.cutoffHours], [true, true, 2]);
    assert.deepEqual(view.deadline, { date: DAY, time: "09:00" }, "2 hours before 11:00, in the shop's time");

    // the token opens this booking in this shop only
    await refused(() => manage.findManaged(db, "gentleman-barber", b.manageToken), (e) => e.status === 404);
    await refused(() => manage.findManaged(db, "bloom-hair", crypto.randomBytes(24).toString("base64url")), (e) => e.status === 404);
    await refused(() => manage.findManaged(db, "bloom-hair", "short"), (e) => e.status === 404);
    await refused(() => manage.cancelManaged(db, "gentleman-barber", b.manageToken), (e) => e.status === 404);
  });
});

test("the customer moves the booking: same stylist, only free times, taken times refused", { skip }, async () => {
  await inTx(async () => {
    const b = await bookAt("11:00");
    await bookAt("15:00"); // someone else has ช่างแนน at 15:00

    const dates = await manage.manageOptions(db, "bloom-hair", b.manageToken, { ask: "date" });
    assert.ok(dates.options.find((o) => o.value === DAY).available);
    const times = (await manage.manageOptions(db, "bloom-hair", b.manageToken, { ask: "time", date: DAY })).options.map((o) => o.value);
    assert.ok(times.includes("11:00"), "the booking does not block itself");
    assert.ok(times.includes("13:00"));
    assert.ok(!times.includes("15:00") && !times.includes("14:30"), "ช่างแนน is busy then");

    const moved = await manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "13:00" });
    assert.deepEqual([moved.booking.start, moved.booking.end, moved.booking.resources[0].name], ["13:00", "14:00", "ช่างแนน"]);

    await refused(
      () => manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "15:00" }),
      (e) => e.status === 409 && e.message === "เวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาอื่น"
    );
    await refused(() => manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "13:05" }), (e) => e.status === 422 && e.details.reason === "INVALID_TIME");
    await refused(() => manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "25:00" }), (e) => e.status === 400);
    await refused(() => manage.manageOptions(db, "bloom-hair", b.manageToken, { ask: "offering" }), (e) => e.status === 400);
  });
});

test("the customer cancels: the reason is kept, the slot frees, and nothing more can change", { skip }, async () => {
  await inTx(async () => {
    const b = await bookAt("11:00");
    const done = await manage.cancelManaged(db, "bloom-hair", b.manageToken, { reason: " ติดธุระ " });
    assert.equal(done.booking.status, "cancelled");
    assert.deepEqual([done.cancel.allowed, done.reschedule.allowed], [false, false]);
    const history = (await db.query("select to_status, reason from public.booking_status_history where booking_id = $1 and to_status = 'cancelled'", [b.id])).rows[0];
    assert.deepEqual(history, { to_status: "cancelled", reason: "ลูกค้ายกเลิกเอง: ติดธุระ" });

    // pressing cancel twice is fine; moving a cancelled booking is not
    assert.equal((await manage.cancelManaged(db, "bloom-hair", b.manageToken)).booking.status, "cancelled");
    await refused(() => manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "13:00" }), (e) => e.status === 422 && e.details.reason === "NOT_CHANGEABLE");
    await bookAt("11:00");
  });
});

test("the shop's rules: switched off, or too close to the time", { skip }, async () => {
  await inTx(async () => {
    const b = await bookAt("11:00");
    await db.query("update public.business_booking_settings set customer_can_cancel = false where business_id = $1", [SALON]);
    let view = await manage.findManaged(db, "bloom-hair", b.manageToken);
    assert.deepEqual([view.cancel.allowed, view.cancel.reason, view.reschedule.allowed], [false, "CUSTOMER_CHANGE_OFF", true]);
    await refused(() => manage.cancelManaged(db, "bloom-hair", b.manageToken), (e) => e.status === 422 && e.details.reason === "CUSTOMER_CHANGE_OFF");

    // 30 days' notice: the booking a few days ahead is already too close
    await db.query("update public.business_booking_settings set customer_can_cancel = true, customer_change_cutoff_hours = 720 where business_id = $1", [SALON]);
    view = await manage.findManaged(db, "bloom-hair", b.manageToken);
    assert.deepEqual([view.cancel.reason, view.reschedule.reason], ["TOO_LATE_TO_CHANGE", "TOO_LATE_TO_CHANGE"]);
    await refused(() => manage.cancelManaged(db, "bloom-hair", b.manageToken), (e) => e.status === 422 && /ใกล้เวลานัด/.test(e.message));
    await refused(() => manage.rescheduleManaged(db, "bloom-hair", b.manageToken, { date: DAY, time: "13:00" }), (e) => e.details.reason === "TOO_LATE_TO_CHANGE");

    // a booking the shop has already marked is out of the customer's hands
    await db.query("update public.business_booking_settings set customer_change_cutoff_hours = 2 where business_id = $1", [SALON]);
    await db.query("select public.set_booking_status($1, 'checked_in')", [b.id]);
    await refused(() => manage.cancelManaged(db, "bloom-hair", b.manageToken), (e) => e.details.reason === "NOT_CHANGEABLE");
  });
});

test("only the server may call the customer functions", { skip }, async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const sql of [
      `select public.customer_cancel_booking('${SALON}', repeat('0', 64))`,
      `select public.customer_reschedule_booking('${SALON}', repeat('0', 64), now() + interval '3 days')`,
      `select public.booking_attach_manage_token('{}'::jsonb, repeat('0', 64))`
    ]) {
      await inTx(async () => {
        await db.query(`set local role ${role}`);
        await refused(() => db.query(sql), (e) => e.code === "42501");
      });
    }
  }
});
