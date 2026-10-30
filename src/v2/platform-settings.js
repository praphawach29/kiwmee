// Platform settings (migration ...001300): the LINE keys set from /super instead of in code or Railway.
//
// Reading (server side, as the database owner):  getSetting(pool, "line.liff_id")
//   the value saved from /super, else the environment variable it replaces, else null. A database that
//   cannot be read (migration not run yet) falls back to the environment instead of breaking the page.
// Writing (a platform admin, as `authenticated`):  listSettings / saveSetting / clearSetting
//   secrets are encrypted here with AES-256-GCM before they reach the database and are never sent back
//   to the browser; the list only says whether one is set and its last 4 characters.
//
// SETTINGS_ENCRYPTION_KEY (at least 32 random characters) is the one value that must stay in the
// environment. If it is lost, saved secrets cannot be read and have to be entered again.

const crypto = require("node:crypto");
const { AppError, badRequest, forbidden } = require("../errors");

const NO_SPACE = /^\S+$/;

const SETTINGS = {
  "line.liff_id": {
    label: "LIFF ID",
    help: "LINE Developers → LINE Login channel → LIFF → LIFF ID (รูปแบบ 1234567890-AbCdEfGh)",
    secret: false,
    env: "NEXT_PUBLIC_LIFF_ID",
    valid: (v) => /^\d{6,}-[A-Za-z0-9]{4,}$/.test(v)
  },
  "line.login_channel_id": {
    label: "LINE Login · Channel ID",
    help: "LINE Developers → LINE Login channel → Basic settings → Channel ID (ตัวเลข)",
    secret: false,
    env: "LINE_LOGIN_CHANNEL_ID",
    valid: (v) => /^\d{6,20}$/.test(v)
  },
  "line.messaging_access_token": {
    label: "Messaging API · Channel access token",
    help: "LINE Developers → Messaging API channel → Messaging API → Channel access token (long-lived)",
    secret: true,
    env: "LINE_CHANNEL_ACCESS_TOKEN",
    valid: (v) => v.length >= 20 && v.length <= 1000 && NO_SPACE.test(v)
  },
  "line.messaging_channel_secret": {
    label: "Messaging API · Channel secret",
    help: "LINE Developers → Messaging API channel → Basic settings → Channel secret",
    secret: true,
    env: "LINE_CHANNEL_SECRET",
    valid: (v) => /^[A-Za-z0-9]{16,64}$/.test(v)
  }
};

const NOT_ADMIN = "เฉพาะผู้ดูแลแพลตฟอร์มเท่านั้น";

// ---------- encryption ----------

function masterKey(env = process.env) {
  const secret = env.SETTINGS_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) return null;
  return Buffer.from(crypto.hkdfSync("sha256", secret, "kiwmee-platform-settings", "aes-256-gcm", 32));
}

function requireMasterKey(env) {
  const key = masterKey(env);
  if (!key) {
    throw new AppError("NOT_CONFIGURED", "ยังไม่ได้ตั้ง SETTINGS_ENCRYPTION_KEY (อย่างน้อย 32 ตัวอักษร) บนเซิร์ฟเวอร์ จึงเก็บความลับไม่ได้", 503);
  }
  return key;
}

// v1.<iv 12><tag 16><ciphertext>, base64url; the setting's name is bound in so a value cannot be moved to another key
function encrypt(name, plain, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", requireMasterKey(env), iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

function decrypt(name, stored, env = process.env) {
  if (!stored.startsWith("v1.")) throw new Error("unknown format");
  const raw = Buffer.from(stored.slice(3), "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", requireMasterKey(env), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------- reading, for server code ----------

const CACHE_MS = 30 * 1000;
const cache = new Map();

function clearCache() {
  cache.clear();
}

function fromEnv(name, env) {
  return env[SETTINGS[name].env]?.trim() || null;
}

/** The value of one setting: saved from /super, else the environment variable, else null. */
async function getSetting(db, name, { env = process.env, now = Date.now(), fresh = false } = {}) {
  if (!SETTINGS[name]) throw new Error(`unknown setting ${name}`);
  const hit = cache.get(name);
  if (!fresh && hit && hit.until > now) return hit.value;
  let value = null;
  try {
    const { rows } = await db.query("select value, is_secret from public.platform_settings where key = $1", [name]);
    if (rows[0]) value = rows[0].is_secret ? decrypt(name, rows[0].value, env) : rows[0].value;
  } catch (error) {
    // not migrated yet, or the encryption key changed: fall back rather than break booking pages
    console.error(`[platform-settings] cannot read ${name}:`, error.code || error.message);
  }
  value = value ?? fromEnv(name, env);
  cache.set(name, { value, until: now + CACHE_MS });
  return value;
}

// ---------- platform admins ----------

async function isPlatformAdmin(client) {
  const { rows } = await client.query("select public.is_platform_admin() as admin");
  return rows[0].admin === true;
}

async function requirePlatformAdmin(client) {
  if (!(await isPlatformAdmin(client))) throw forbidden(NOT_ADMIN);
}

/** What /super shows: every known setting, whether it is set and from where. Secrets are never included. */
async function listSettings(client, { env = process.env } = {}) {
  await requirePlatformAdmin(client);
  const { rows } = await client.query("select key, is_secret, value, hint, updated_at from public.platform_settings_list()");
  const saved = new Map(rows.map((r) => [r.key, r]));
  return {
    encryptionReady: masterKey(env) !== null,
    settings: Object.entries(SETTINGS).map(([key, def]) => {
      const row = saved.get(key);
      return {
        key,
        label: def.label,
        help: def.help,
        secret: def.secret,
        source: row ? "database" : fromEnv(key, env) ? "environment" : "none",
        value: row && !def.secret ? row.value : null,
        hint: row?.hint ?? null,
        updatedAt: row?.updated_at ?? null
      };
    })
  };
}

async function saveSetting(client, { key, value } = {}, { env = process.env } = {}) {
  await requirePlatformAdmin(client);
  const def = SETTINGS[key];
  if (!def) throw badRequest("ไม่รู้จักค่านี้");
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw badRequest("กรุณากรอกค่า");
  if (!def.valid(text)) throw badRequest(`รูปแบบของ ${def.label} ไม่ถูกต้อง ตรวจว่าคัดลอกมาครบ`);
  const stored = def.secret ? encrypt(key, text, env) : text;
  const hint = def.secret ? `••••${text.slice(-4)}` : null;
  await client.query("select public.platform_setting_set($1, $2, $3, $4)", [key, stored, def.secret, hint]);
  clearCache();
}

async function clearSetting(client, { key } = {}) {
  await requirePlatformAdmin(client);
  if (!SETTINGS[key]) throw badRequest("ไม่รู้จักค่านี้");
  await client.query("select public.platform_setting_clear($1)", [key]);
  clearCache();
}

/** Asks LINE who the saved Messaging API token belongs to: proves the token (not the channel secret) works. */
async function testMessagingToken(db, { fetchImpl = fetch, env = process.env } = {}) {
  const token = await getSetting(db, "line.messaging_access_token", { env, fresh: true });
  if (!token) throw badRequest("ยังไม่ได้ตั้ง Channel access token");
  let response;
  try {
    response = await fetchImpl("https://api.line.me/v2/bot/info", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new AppError("LINE_UNAVAILABLE", "เชื่อมต่อ LINE ไม่ได้ในตอนนี้ ลองใหม่อีกครั้ง", 502);
  }
  if (response.status === 401) {
    throw new AppError("LINE_REJECTED", "LINE ไม่ยอมรับ token นี้ ตรวจว่าเป็น long-lived token ของ Messaging API channel", 422);
  }
  if (!response.ok) throw new AppError("LINE_UNAVAILABLE", `LINE ตอบกลับผิดปกติ (${response.status})`, 502);
  const info = await response.json();
  return { ok: true, name: info.displayName ?? null, basicId: info.basicId ?? null };
}

module.exports = {
  SETTINGS,
  getSetting,
  clearCache,
  listSettings,
  saveSetting,
  clearSetting,
  isPlatformAdmin,
  testMessagingToken,
  encrypt,
  decrypt,
  masterKey
};
