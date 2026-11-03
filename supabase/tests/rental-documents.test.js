// Rental documents (migration …002700, design 11.7 E3) against the test database: the customer agrees
// and uploads from their booking link, the picture is stored encrypted, only that shop's members can
// see it (through the server), and it is deleted on schedule or when the booking is called off.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const { book } = require("../../src/v2/public-booking");
const manage = require("../../src/v2/manage-booking");
const docs = require("../../src/v2/rental-documents");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";
const SALON = "b1000000-0000-4000-8000-000000000001";
const BARBER = "b2000000-0000-4000-8000-000000000002";
const CUT = "c1000000-0000-4000-8000-000000000001";
const NAN = "a1000000-0000-4000-8000-000000000001";
const OWNER = { id: "ed000000-0000-4000-8000-000000000001" };
const DESK = { id: "ed000000-0000-4000-8000-000000000002" };
const RIVAL = { id: "ed000000-0000-4000-8000-000000000003" };
const ID_CARD = Buffer.from("RIFF0000WEBPVP8 pretend id card picture with a name and number 1-2345-67890-12-3");
const env = { ...process.env, SETTINGS_ENCRYPTION_KEY: "d".repeat(40) };

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

async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [OWNER.id, DESK.id, RIVAL.id]);
    await db.query("insert into public.business_members (business_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'staff'), ($2, $5, 'owner')",
      [SALON, BARBER, OWNER.id, DESK.id, RIVAL.id]);
    await db.query("update public.offerings set required_documents = '{id_card}' where id = $1", [CUT]);
    const made = await book(db, "bloom-hair", { selected: { offeringId: CUT, resourceId: NAN, date: bangkokTuesday(3), time: "11:00" }, customer: { name: "ผู้เช่า", phone: "0812345678" } });
    return await fn(made);
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

const upload = (made, input) => manage.submitManagedDocument(db, "bloom-hair", made.manageToken, input, { env });

test("the customer agrees, then uploads; it is stored encrypted and shows as received", { skip }, async () => {
  await inTx(async (made) => {
    const before = await manage.findManaged(db, "bloom-hair", made.manageToken);
    assert.deepEqual(before.documents.required, [{ kind: "id_card", label: "บัตรประชาชน" }]);
    assert.deepEqual([before.documents.uploaded, before.documents.retentionDays], [[], 30]);

    await refused(() => upload(made, { kind: "id_card", consent: false, image: ID_CARD }), (e) => e.status === 422 && e.code === "CONSENT_REQUIRED");
    await refused(() => upload(made, { kind: "passport", consent: true, image: ID_CARD }), (e) => e.status === 422);
    const after = await upload(made, { kind: "id_card", consent: true, image: ID_CARD });
    assert.deepEqual(after.documents.uploaded.map((d) => [d.kind, d.reviewed]), [["id_card", false]]);

    const { rows: [row] } = await db.query("select sealed, consent_at, delete_after, (select end_at from public.bookings where id = booking_id) as end_at from public.booking_documents");
    assert.ok(!row.sealed.includes(Buffer.from("1-2345-67890")), "the number is not readable in the database");
    assert.ok(!row.sealed.subarray(0, 4).equals(Buffer.from("RIFF")));
    assert.ok(row.consent_at);
    assert.equal(Math.round((row.delete_after - row.end_at) / 86400000), 30, "kept 30 days after the booking ends");

    // a second upload of the same kind replaces the first
    await upload(made, { kind: "id_card", consent: true, image: Buffer.from("RIFF0000WEBP another") });
    assert.equal((await db.query("select count(*)::int as n from public.booking_documents")).rows[0].n, 1);
  });
});

test("the shop's members see and check it through the server; another shop, anon and direct writes cannot", { skip }, async () => {
  await inTx(async (made) => {
    await upload(made, { kind: "id_card", consent: true, image: ID_CARD });

    await admin.actAs(db, DESK);
    const desk = await admin.memberShop(db, "bloom-hair");
    const [doc] = await docs.listDocuments(db, desk, made.id);
    assert.equal(doc.label, "บัตรประชาชน");
    const pic = await docs.readDocument(db, desk, doc.id, { env });
    assert.ok(pic.image.equals(ID_CARD), "decrypted back to the same picture");
    await docs.reviewDocument(db, desk, doc.id);
    assert.ok((await docs.listDocuments(db, desk, made.id))[0].reviewedAt);
    await refused(() => db.query("update public.booking_documents set sealed = 'x' where id = $1", [doc.id]), (e) => e.code === "42501");
    await refused(() => db.query("insert into public.booking_documents (business_id, booking_id, kind, sealed, consent_at, delete_after) values ($1, $2, 'passport', '\\x00', now(), now())", [SALON, made.id]), (e) => e.code === "42501");
    await refused(() => db.query("select public.customer_submit_document($1, $2, 'id_card', '\\x00')", [SALON, "a".repeat(64)]), (e) => e.code === "42501");

    await admin.actAs(db, RIVAL);
    const rival = await admin.memberShop(db, "gentleman-barber");
    assert.equal((await db.query("select count(*)::int as n from public.booking_documents")).rows[0].n, 0, "RLS hides another shop's documents");
    await refused(() => docs.readDocument(db, rival, doc.id, { env }), (e) => e.status === 404);

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.booking_documents"), (e) => e.code === "42501");
    await db.query("reset role");

    // a member may delete it early
    await admin.actAs(db, DESK);
    await docs.deleteDocument(db, desk, doc.id);
    assert.deepEqual(await docs.listDocuments(db, desk, made.id), []);
  });
});

test("deleted on schedule, and at once when the booking is called off", { skip }, async () => {
  await inTx(async (made) => {
    await upload(made, { kind: "id_card", consent: true, image: ID_CARD });
    assert.equal(await docs.purgeDocuments(db), 0, "not yet");
    assert.equal(await docs.purgeDocuments(db, new Date(Date.now() + 400 * 86400000)), 1, "past its date");

    await upload(made, { kind: "id_card", consent: true, image: ID_CARD });
    await manage.cancelManaged(db, "bloom-hair", made.manageToken, {});
    assert.equal(await docs.purgeDocuments(db), 1, "cancelled: gone");
    await refused(() => upload(made, { kind: "id_card", consent: true, image: ID_CARD }), (e) => e.status === 422, "no uploads to a cancelled booking");
  });
});

test("the owner picks the documents a service asks for and how long they are kept", { skip }, async () => {
  await inTx(async () => {
    await admin.actAs(db, OWNER);
    const shop = await admin.memberShop(db, "bloom-hair", { owner: true });
    await admin.saveOffering(db, shop, CUT, { name: "ตัดผม", durationMinutes: 60, requiredDocuments: ["driving_license", "id_card"] });
    let catalog = await admin.getCatalog(db, shop);
    assert.deepEqual(catalog.offerings.find((o) => o.id === CUT).requiredDocuments, ["id_card", "driving_license"]);
    await admin.saveOffering(db, shop, CUT, { name: "ตัดผม", durationMinutes: 60 }); // not sent: kept
    assert.deepEqual((await admin.getCatalog(db, shop)).offerings.find((o) => o.id === CUT).requiredDocuments, ["id_card", "driving_license"]);
    await refused(() => admin.saveOffering(db, shop, CUT, { name: "ตัดผม", durationMinutes: 60, requiredDocuments: ["selfie"] }), (e) => e.status === 422);

    catalog = await admin.getCatalog(db, shop);
    await admin.saveShop(db, shop, { name: catalog.shop.name, settings: { ...catalog.settings, documentRetentionDays: 7 } });
    assert.equal((await admin.getCatalog(db, shop)).settings.documentRetentionDays, 7);
    await refused(() => admin.saveShop(db, shop, { name: catalog.shop.name, settings: { ...catalog.settings, documentRetentionDays: 0 } }), (e) => e.status === 422);
  });
});
