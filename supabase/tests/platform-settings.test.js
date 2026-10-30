// Platform settings and super admins (migration ...001300) against the test database: only platform
// admins reach them, secrets are stored encrypted and never come back, in rolled-back transactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const admin = require("../../src/v2/admin-catalog");
const settings = require("../../src/v2/platform-settings");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const ENV = { SETTINGS_ENCRYPTION_KEY: "k".repeat(40) };
const TOKEN = "T".repeat(30);
const USERS = {
  root: { id: "e7000000-0000-4000-8000-00000000000a", email: "root@test.local" },
  owner: { id: "e7000000-0000-4000-8000-00000000000b", email: "shop-owner@test.local" }
};

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

// root is a platform admin; owner is only a signed-in user
async function inTx(fn) {
  await db.query("begin");
  try {
    await db.query("insert into auth.users (id, email) select * from unnest($1::uuid[], $2::text[])", [
      Object.values(USERS).map((u) => u.id),
      Object.values(USERS).map((u) => u.email)
    ]);
    await db.query("insert into public.platform_admins (user_id) values ($1)", [USERS.root.id]);
    settings.clearCache();
    return await fn();
  } finally {
    await db.query("rollback");
    settings.clearCache();
  }
}

async function as(user) {
  await db.query("reset role");
  if (user === "anon") await db.query("set local role anon");
  else await admin.actAs(db, user);
}

// Runs fn inside a savepoint and expects SQLSTATE 42501 (permission denied)
async function denied(fn) {
  await db.query("savepoint expect_denied");
  try {
    await assert.rejects(fn, (e) => e.code === "42501" || e.code === "FORBIDDEN", "expected a refusal");
  } finally {
    await db.query("rollback to savepoint expect_denied");
  }
}

const STATEMENTS = [
  "select * from public.platform_settings",
  "select * from public.platform_admins",
  "insert into public.platform_admins (user_id) values (gen_random_uuid())",
  "insert into public.platform_settings (key, value) values ('line.liff_id', 'x')",
  "select * from public.platform_settings_list()",
  "select public.platform_setting_set('line.liff_id', 'x', false, null)",
  "select public.platform_setting_clear('line.liff_id')",
  "select public.platform_assert_admin()"
];

test("anon reaches nothing", { skip }, async () => {
  await inTx(async () => {
    await as("anon");
    for (const sql of [...STATEMENTS, "select public.is_platform_admin()"]) await denied(() => db.query(sql));
  });
});

test("a signed-in user who is not a platform admin reaches nothing and cannot make themselves one", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.owner);
    for (const sql of STATEMENTS) await denied(() => db.query(sql));
    assert.equal(await settings.isPlatformAdmin(db), false);
    await denied(() => settings.listSettings(db));
    await denied(() => settings.saveSetting(db, { key: "line.liff_id", value: "1234567890-AbCdEfGh" }, { env: ENV }));
    await denied(() => settings.clearSetting(db, { key: "line.liff_id" }));
  });
});

test("a platform admin saves a plain value and a secret; the secret is encrypted and never listed", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.root);
    assert.equal(await settings.isPlatformAdmin(db), true);
    await settings.saveSetting(db, { key: "line.liff_id", value: "1234567890-AbCdEfGh" }, { env: ENV });
    await settings.saveSetting(db, { key: "line.messaging_access_token", value: TOKEN }, { env: ENV });

    const list = await settings.listSettings(db, { env: ENV });
    assert.equal(list.encryptionReady, true);
    const by = Object.fromEntries(list.settings.map((s) => [s.key, s]));
    assert.equal(by["line.liff_id"].source, "database");
    assert.equal(by["line.liff_id"].value, "1234567890-AbCdEfGh");
    assert.equal(by["line.messaging_access_token"].value, null);
    assert.equal(by["line.messaging_access_token"].hint, "••••TTTT");
    assert.equal(by["line.login_channel_id"].source, "none");
    assert.ok(!JSON.stringify(list).includes(TOKEN));

    // what the database holds, and what the server reads back
    await db.query("reset role");
    const stored = (await db.query("select value, updated_by from public.platform_settings where key = 'line.messaging_access_token'")).rows[0];
    assert.ok(!stored.value.includes(TOKEN));
    assert.equal(stored.updated_by, USERS.root.id);
    assert.equal(await settings.getSetting(db, "line.messaging_access_token", { env: ENV, fresh: true }), TOKEN);
    assert.equal(await settings.getSetting(db, "line.liff_id", { env: {}, fresh: true }), "1234567890-AbCdEfGh");
  });
});

test("saving again replaces the value; clearing falls back to the environment", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.root);
    await settings.saveSetting(db, { key: "line.login_channel_id", value: "111111" }, { env: ENV });
    await settings.saveSetting(db, { key: "line.login_channel_id", value: "222222" }, { env: ENV });
    await db.query("reset role");
    assert.equal((await db.query("select count(*)::int as n from public.platform_settings")).rows[0].n, 1);
    assert.equal(await settings.getSetting(db, "line.login_channel_id", { env: {}, fresh: true }), "222222");

    await as(USERS.root);
    await settings.clearSetting(db, { key: "line.login_channel_id" });
    await db.query("reset role");
    assert.equal(await settings.getSetting(db, "line.login_channel_id", { env: { LINE_LOGIN_CHANNEL_ID: "999999" }, fresh: true }), "999999");
  });
});

test("the database refuses a malformed setting name", { skip }, async () => {
  await inTx(async () => {
    await as(USERS.root);
    await db.query("savepoint bad_key");
    await assert.rejects(db.query("select public.platform_setting_set('Bad Key', 'x', false, null)"), (e) => e.code === "23514");
    await db.query("rollback to savepoint bad_key");
  });
});
