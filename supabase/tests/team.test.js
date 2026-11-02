// The shop team (src/v2/admin-team.js, migration …001700) against the test database, as a signed-in
// user exactly as app/api/dashboard/shops/[slug]/team* does, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const brands = require("../../src/v2/admin-brands");
const team = require("../../src/v2/admin-team");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const USERS = {
  owner: { id: "e7000000-0000-4000-8000-00000000000a", email: "owner@team.test" },
  existing: { id: "e7000000-0000-4000-8000-00000000000b", email: "existing@team.test" },
  barber: { id: "e7000000-0000-4000-8000-00000000000c", email: "barber@team.test" }
};
const NEWCOMER = { id: "e7000000-0000-4000-8000-00000000000d", email: "new.stylist@team.test" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

// Two fresh shops: "team-shop" owned by `owner` alone, "team-other" owned by `barber`
async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await admin.actAs(db, USERS.owner);
    await admin.createShop(db, { name: "ร้านทีม", slug: "team-shop" });
    await db.query("reset role");
    await admin.actAs(db, USERS.barber);
    await admin.createShop(db, { name: "ร้านอื่น", slug: "team-other" });
    await db.query("reset role");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function as(user, slug = "team-shop", { owner = false } = {}) {
  await db.query("reset role");
  await admin.actAs(db, user);
  return slug ? admin.memberShop(db, slug, { owner }) : null;
}

async function refused(fn, check) {
  await db.query("savepoint expect_error");
  try {
    await assert.rejects(fn, check);
  } finally {
    await db.query("rollback to savepoint expect_error");
  }
}

test("an invite waits for the person to sign up, then becomes a membership", { skip }, async () => {
  await inTx(async () => {
    let shop = await as(USERS.owner, "team-shop", { owner: true });
    assert.deepEqual(await team.inviteMember(db, shop, { email: "  New.Stylist@Team.test ", role: "staff" }), {
      status: "invited",
      id: (await team.getTeam(db, shop)).invites[0]?.id ?? null,
      email: "new.stylist@team.test",
      role: "staff"
    });
    // inviting again changes the role instead of adding a second invite
    await team.inviteMember(db, shop, { email: "new.stylist@team.test", role: "owner" });
    let t = await team.getTeam(db, shop);
    assert.deepEqual(t.invites.map((i) => [i.email, i.role]), [["new.stylist@team.test", "owner"]]);
    assert.deepEqual(t.members.map((m) => [m.email, m.role, m.you]), [["owner@team.test", "owner", true]]);
    await team.inviteMember(db, shop, { email: "new.stylist@team.test", role: "staff" });

    // they sign up later; opening /dashboard takes the invite up
    await db.query("reset role");
    await db.query("insert into auth.users (id, email) values ($1, $2)", [NEWCOMER.id, NEWCOMER.email]);
    await as(NEWCOMER, null);
    const list = await brands.listBrands(db);
    assert.deepEqual(list.flatMap((b) => b.shops.map((s) => [s.slug, s.role])), [["team-shop", "staff"]]);

    shop = await as(USERS.owner, "team-shop", { owner: true });
    t = await team.getTeam(db, shop);
    assert.deepEqual(t.invites, []);
    assert.deepEqual(t.members.map((m) => [m.email, m.role]).sort(), [["new.stylist@team.test", "staff"], ["owner@team.test", "owner"]]);
  });
});

test("an address nobody has confirmed takes up no invite", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.owner, "team-shop", { owner: true });
    await team.inviteMember(db, shop, { email: NEWCOMER.email });
    await db.query("reset role");
    await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, null)", [NEWCOMER.id, NEWCOMER.email]);
    await as(NEWCOMER, null);
    assert.deepEqual(await brands.listBrands(db), []);
    assert.equal((await db.query("select public.accept_my_invites() as n")).rows[0].n, 0);
  });
});

test("an existing account joins at once; roles change; the shop keeps an owner", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.owner, "team-shop", { owner: true });
    assert.equal((await team.inviteMember(db, shop, { email: "EXISTING@team.test" })).status, "added");
    await refused(() => team.inviteMember(db, shop, { email: "existing@team.test" }), (e) => e.status === 422 && e.message === "อีเมลนี้อยู่ในร้านนี้แล้ว");
    await refused(() => team.inviteMember(db, shop, { email: "not-an-email" }), (e) => e.status === 422);
    await refused(() => team.inviteMember(db, shop, { email: "x@y.co", role: "admin" }), (e) => e.status === 422);

    // the only owner cannot step down or leave
    await refused(() => team.setMemberRole(db, shop, USERS.owner.id, { role: "staff" }), (e) => e.details.reason === "LAST_OWNER");
    await refused(() => team.removeMember(db, shop, USERS.owner.id), (e) => e.details.reason === "LAST_OWNER");

    await team.setMemberRole(db, shop, USERS.existing.id, { role: "owner" });
    await team.setMemberRole(db, shop, USERS.owner.id, { role: "staff" });
    let t = await team.getTeam(db, (await as(USERS.existing, "team-shop", { owner: true })));
    assert.deepEqual(t.members.map((m) => [m.email, m.role]).sort(), [["existing@team.test", "owner"], ["owner@team.test", "staff"]]);

    const shop2 = await as(USERS.existing, "team-shop", { owner: true });
    await team.removeMember(db, shop2, USERS.owner.id);
    t = await team.getTeam(db, shop2);
    assert.deepEqual(t.members.map((m) => m.email), ["existing@team.test"]);
    await refused(() => team.removeMember(db, shop2, USERS.owner.id), (e) => e.status === 404);
  });
});

test("invites can be withdrawn", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.owner, "team-shop", { owner: true });
    const { id } = await team.inviteMember(db, shop, { email: "maybe@team.test" });
    await team.cancelInvite(db, shop, id);
    assert.deepEqual((await team.getTeam(db, shop)).invites, []);
    await refused(() => team.cancelInvite(db, shop, id), (e) => e.status === 404);
  });
});

test("staff and other shops cannot touch the team; nobody writes invites around the RPCs", { skip }, async () => {
  await inTx(async () => {
    const shop = await as(USERS.owner, "team-shop", { owner: true });
    await team.inviteMember(db, shop, { email: "existing@team.test", role: "staff" });
    const { id } = await team.inviteMember(db, shop, { email: "later@team.test" });

    const asStaff = await as(USERS.existing);
    await refused(() => team.getTeam(db, asStaff), (e) => e.code === "42501");
    await refused(() => team.inviteMember(db, asStaff, { email: "friend@team.test" }), (e) => e.code === "42501");
    await refused(() => team.setMemberRole(db, asStaff, USERS.existing.id, { role: "owner" }), (e) => e.code === "42501");
    await refused(() => admin.memberShop(db, "team-shop", { owner: true }), (e) => e.status === 403);
    assert.deepEqual((await db.query("select * from public.business_invites")).rows, [], "staff see no invites");

    // another shop's owner, even with team-shop's id in hand
    const other = await as(USERS.barber, "team-other", { owner: true });
    await refused(() => team.getTeam(db, { id: shop.id }), (e) => e.code === "42501");
    await refused(() => team.cancelInvite(db, { id: shop.id }, id), (e) => e.code === "42501");
    await refused(() => team.removeMember(db, { id: shop.id }, USERS.owner.id), (e) => e.code === "42501");
    await refused(
      () => db.query("insert into public.business_invites (business_id, email, role) values ($1, 'x@y.co', 'owner')", [other.id]),
      (e) => e.code === "42501"
    );

    await db.query("reset role");
    await db.query("set local role anon");
    await refused(() => db.query("select * from public.business_invites"), (e) => e.code === "42501");
    await refused(() => db.query("select public.accept_my_invites()"), (e) => e.code === "42501");
  });
});
