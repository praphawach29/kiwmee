// Platform settings without a database: encryption, validation and the fallback to the environment.
const test = require("node:test");
const assert = require("node:assert/strict");
const settings = require("../src/v2/platform-settings");

const ENV = { SETTINGS_ENCRYPTION_KEY: "k".repeat(40) };
const TOKEN = "T".repeat(30);

test.beforeEach(() => settings.clearCache());

test("a secret survives encryption and the stored form does not contain it", () => {
  const stored = settings.encrypt("line.messaging_access_token", TOKEN, ENV);
  assert.match(stored, /^v1\./);
  assert.ok(!stored.includes(TOKEN));
  assert.equal(settings.decrypt("line.messaging_access_token", stored, ENV), TOKEN);
});

test("each encryption is different, and a value cannot be moved to another setting or read with another key", () => {
  const a = settings.encrypt("line.messaging_access_token", TOKEN, ENV);
  assert.notEqual(a, settings.encrypt("line.messaging_access_token", TOKEN, ENV));
  assert.throws(() => settings.decrypt("line.messaging_channel_secret", a, ENV));
  assert.throws(() => settings.decrypt("line.messaging_access_token", a, { SETTINGS_ENCRYPTION_KEY: "z".repeat(40) }));
  const raw = Buffer.from(a.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => settings.decrypt("line.messaging_access_token", `v1.${raw.toString("base64url")}`, ENV));
});

test("without SETTINGS_ENCRYPTION_KEY (or a short one) nothing secret is stored", () => {
  for (const env of [{}, { SETTINGS_ENCRYPTION_KEY: "short" }]) {
    assert.equal(settings.masterKey(env), null);
    assert.throws(() => settings.encrypt("line.messaging_access_token", TOKEN, env), (e) => e.code === "NOT_CONFIGURED");
  }
});

// a client that answers like the database for the calls saveSetting makes
function fakeClient({ admin = true } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/is_platform_admin/.test(sql)) return { rows: [{ admin }] };
      return { rows: [] };
    }
  };
}

test("saving checks the format, the admin and the key", async () => {
  const bad = async (client, body, code) =>
    assert.rejects(settings.saveSetting(client, body, { env: ENV }), (e) => e.code === code, JSON.stringify(body));
  await bad(fakeClient({ admin: false }), { key: "line.liff_id", value: "1234567890-AbCdEfGh" }, "FORBIDDEN");
  await bad(fakeClient(), { key: "nope", value: "x" }, "BAD_REQUEST");
  await bad(fakeClient(), { key: "line.liff_id", value: "  " }, "BAD_REQUEST");
  await bad(fakeClient(), { key: "line.liff_id", value: "not a liff id" }, "BAD_REQUEST");
  await bad(fakeClient(), { key: "line.login_channel_id", value: "abc" }, "BAD_REQUEST");
  await bad(fakeClient(), { key: "line.messaging_access_token", value: "short" }, "BAD_REQUEST");
});

test("a plain setting is saved as typed; a secret is encrypted and leaves only its last 4 characters", async () => {
  const plain = fakeClient();
  await settings.saveSetting(plain, { key: "line.liff_id", value: " 1234567890-AbCdEfGh " }, { env: ENV });
  const [, set] = plain.calls;
  assert.deepEqual(set.params, ["line.liff_id", "1234567890-AbCdEfGh", false, null]);

  const secret = fakeClient();
  await settings.saveSetting(secret, { key: "line.messaging_access_token", value: TOKEN }, { env: ENV });
  const [, saved] = secret.calls;
  assert.equal(saved.params[2], true);
  assert.ok(!saved.params[1].includes(TOKEN));
  assert.equal(settings.decrypt("line.messaging_access_token", saved.params[1], ENV), TOKEN);
  assert.equal(saved.params[3], "••••TTTT");
  await assert.rejects(settings.saveSetting(fakeClient(), { key: "line.messaging_access_token", value: TOKEN }, { env: {} }), (e) => e.code === "NOT_CONFIGURED");
});

test("getSetting: the saved value, else the environment, else null; a broken database falls back", async () => {
  const stored = settings.encrypt("line.messaging_access_token", TOKEN, ENV);
  const db = (rows) => ({ query: async () => ({ rows }) });
  const env = { ...ENV, LINE_LOGIN_CHANNEL_ID: " 111111 " };

  assert.equal(await settings.getSetting(db([{ value: "222222", is_secret: false }]), "line.login_channel_id", { env }), "222222");
  settings.clearCache();
  assert.equal(await settings.getSetting(db([]), "line.login_channel_id", { env }), "111111");
  settings.clearCache();
  assert.equal(await settings.getSetting(db([]), "line.liff_id", { env }), null);
  settings.clearCache();
  assert.equal(await settings.getSetting(db([{ value: stored, is_secret: true }]), "line.messaging_access_token", { env }), TOKEN);
  settings.clearCache();
  const broken = { query: async () => { throw Object.assign(new Error("no such table"), { code: "42P01" }); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await settings.getSetting(broken, "line.login_channel_id", { env }), "111111");
    // a secret that cannot be decrypted (key changed) is treated as not set
    settings.clearCache();
    assert.equal(await settings.getSetting(db([{ value: stored, is_secret: true }]), "line.messaging_access_token", { env: { SETTINGS_ENCRYPTION_KEY: "z".repeat(40) } }), null);
  } finally {
    console.error = quiet;
  }
});

test("getSetting remembers the answer for a short while", async () => {
  let reads = 0;
  const db = { query: async () => (reads++, { rows: [{ value: "333333", is_secret: false }] }) };
  await settings.getSetting(db, "line.login_channel_id", { env: {}, now: 1000 });
  await settings.getSetting(db, "line.login_channel_id", { env: {}, now: 2000 });
  assert.equal(reads, 1);
  await settings.getSetting(db, "line.login_channel_id", { env: {}, now: 1000 + 31000 });
  assert.equal(reads, 2);
});

test("the token test reports who LINE says the token belongs to, and why it fails", async () => {
  const db = { query: async () => ({ rows: [{ value: settings.encrypt("line.messaging_access_token", TOKEN, ENV), is_secret: true }] }) };
  let seen;
  const ok = await settings.testMessagingToken(db, {
    env: ENV,
    fetchImpl: async (url, init) => ((seen = { url, auth: init.headers.authorization }), Response.json({ displayName: "Kiwmee", basicId: "@kiwmee" }))
  });
  assert.deepEqual(ok, { ok: true, name: "Kiwmee", basicId: "@kiwmee" });
  assert.equal(seen.url, "https://api.line.me/v2/bot/info");
  assert.equal(seen.auth, `Bearer ${TOKEN}`);

  const refused = settings.testMessagingToken(db, { env: ENV, fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(refused, (e) => e.code === "LINE_REJECTED");
  const down = settings.testMessagingToken(db, { env: ENV, fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(down, (e) => e.code === "LINE_UNAVAILABLE");
  await assert.rejects(settings.testMessagingToken({ query: async () => ({ rows: [] }) }, { env: {} }), (e) => e.code === "BAD_REQUEST");
});
