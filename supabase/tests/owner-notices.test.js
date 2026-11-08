// B8 (migration …004500): a brand owner links LINE with a one-time code, then hears about the plan
// ending, the wallet being short and the month's usage, each notice once. Real SQL, cleaned up after.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const url = process.env.SUPABASE_TEST_DB_URL;
const skip = !url && "set SUPABASE_TEST_DB_URL (scripts/db-test.sh)";

const OWNER = { id: "e8500000-0000-4000-8000-000000000001", email: "notice-owner@test.local" };
const OTHER = { id: "e8500000-0000-4000-8000-000000000002", email: "notice-other@test.local" };
const LINE_ID = `U${"b".repeat(32)}`;
const ENV = { NEXT_PUBLIC_LIFF_ID: "1234567890-AbCdEfGh" };

let db;
test.before(async () => {
  if (skip) return;
  db = new Client({ connectionString: url });
  await db.connect();
});
test.after(async () => db && db.end());

test("owners link LINE once with a code, then hear each plan notice once; nobody else reads the tables", { skip }, async () => {
  process.env.BOOKING_DB_URL = url;
  const notices = require("../../src/v2/owner-notices");
  const pool = require("../../src/v2/db").getBookingPool();
  await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4) on conflict do nothing", [OWNER.id, OWNER.email, OTHER.id, OTHER.email]);
  const { rows: [shop] } = await db.query("insert into public.businesses (name, slug) values ('ร้านแจ้งเตือน', 'owner-notice-shop') returning id, brand_id");
  const { rows: [quiet] } = await db.query("insert into public.businesses (name, slug) values ('ร้านไม่ได้เชื่อม', 'owner-notice-quiet') returning id, brand_id");
  await db.query("insert into public.brand_members (brand_id, user_id) values ($1, $2), ($3, $4)", [shop.brand_id, OWNER.id, quiet.brand_id, OTHER.id]);
  const verifyLineToken = async (token) => (token === "good" ? { sub: LINE_ID, name: "พี่เจ้าของ" } : null);
  const pushed = [];
  const push = async (to, messages) => {
    pushed.push({ to, messages });
    return { sent: true };
  };
  try {
    // ---- linking ----
    assert.deepEqual(await notices.linkStatus(OWNER.id), { linked: false, lineName: null, linkedAt: null });
    const start = await notices.startLink(OWNER.id, { env: ENV });
    const code = start.url.split("/owner-line/")[1];
    assert.match(start.url, /^https:\/\/liff\.line\.me\/1234567890-AbCdEfGh\/owner-line\/[A-Za-z0-9_-]{24}$/);
    assert.match(start.qr, /^data:image\/png;base64,/);
    const { rows: [stored] } = await db.query("select code_hash, line_user_id from public.owner_line_links where user_id = $1", [OWNER.id]);
    assert.equal(stored.code_hash, notices.hashCode(code)); // only the hash is kept
    assert.equal(stored.line_user_id, null);

    await assert.rejects(notices.finishLink(pool, { code: "Z".repeat(24), lineIdToken: "good" }, { verifyLineToken, push }), (e) => e.status === 410);
    await assert.rejects(notices.finishLink(pool, { code, lineIdToken: "bad" }, { verifyLineToken, push }), (e) => e.status === 401);
    const done = await notices.finishLink(pool, { code, lineIdToken: "good" }, { verifyLineToken, push });
    assert.deepEqual(done, { linked: true, lineName: "พี่เจ้าของ", delivered: true });
    assert.match(pushed[0].messages[0].text, /เชื่อม LINE \(พี่เจ้าของ\) กับ Kiwmee แล้ว/);
    await assert.rejects(notices.finishLink(pool, { code, lineIdToken: "good" }, { verifyLineToken, push }), (e) => e.status === 410); // once
    const status = await notices.linkStatus(OWNER.id);
    assert.deepEqual([status.linked, status.lineName], [true, "พี่เจ้าของ"]);
    assert.deepEqual(await notices.testLink(OWNER.id, { push }), { delivered: true });

    // an old code no longer works
    const other = await notices.startLink(OTHER.id, { env: ENV });
    await db.query("update public.owner_line_links set code_expires_at = now() - interval '1 minute' where user_id = $1", [OTHER.id]);
    await assert.rejects(notices.finishLink(pool, { code: other.url.split("/owner-line/")[1], lineIdToken: "good" }, { verifyLineToken, push }), (e) => e.status === 410);

    // ---- notices ----
    // starter ends in 2 days, empty wallet; 850 of 900 messages used this month
    await db.query(
      `update public.brand_plans set plan = 'starter', cycle = 'month', valid_until = now() + interval '2 days', complimentary = false,
              trial = false, auto_renew = true, grace_until = null, next_plan = null, next_cycle = null where brand_id = $1`,
      [shop.brand_id]
    );
    await db.query(
      `insert into public.usage_counters (brand_id, period, messages_used, messages_included)
       values ($1, date_trunc('month', now() at time zone 'Asia/Bangkok')::date, 850, 900)`,
      [shop.brand_id]
    );
    await db.query("update public.brand_plans set plan = 'starter', valid_until = now() + interval '1 day' where brand_id = $1", [quiet.brand_id]);
    pushed.length = 0;
    const first = await notices.sendOwnerNotices(pool, { push, anyHour: true, env: { PUBLIC_ORIGIN: "https://kiwmee.example" } });
    assert.equal(first.sent, 2);
    assert.deepEqual(pushed.map((p) => p.to), [LINE_ID, LINE_ID]); // the brand without a linked owner hears nothing
    const texts = pushed.map((p) => p.messages[0].altText);
    assert.ok(texts.includes("ร้านแจ้งเตือน: เงินในกระเป๋าไม่พอต่ออายุ"), texts.join(" | "));
    assert.ok(texts.includes("ร้านแจ้งเตือน: ข้อความ LINE ใช้ไป 94%"), texts.join(" | "));
    assert.match(JSON.stringify(pushed[0].messages[0]), new RegExp(`https://kiwmee.example/dashboard/wallet\\?brand=${shop.brand_id}`));
    const { rows: claimed } = await db.query("select kind, key, result from public.owner_notices where brand_id = $1 order by kind", [shop.brand_id]);
    assert.deepEqual(claimed.map((r) => [r.kind, r.result]), [["expiring", "sent"], ["usage", "sent"]]);
    assert.match(claimed[0].key, /:3$/);

    const again = await notices.sendOwnerNotices(pool, { push, anyHour: true, env: {} });
    assert.deepEqual([again.sent, again.skipped], [0, 2]); // each once

    // night time: nothing is checked
    assert.deepEqual(await notices.sendOwnerNotices(pool, { push, now: new Date("2026-11-08T16:00:00Z") }), { brands: 0, sent: 0, skipped: 0 });

    // unlinked: no more notices
    await notices.unlink(OWNER.id);
    assert.equal((await notices.linkStatus(OWNER.id)).linked, false);
    await db.query("update public.usage_counters set messages_used = 900 where brand_id = $1", [shop.brand_id]);
    pushed.length = 0;
    await notices.sendOwnerNotices(pool, { push, anyHour: true, env: {} });
    assert.equal(pushed.length, 0);

    // nobody signed in (or anonymous) reads or writes either table
    for (const role of ["authenticated", "anon"]) {
      await db.query("begin");
      await db.query(`set local role ${role}`);
      for (const sql of ["select * from public.owner_line_links", "select * from public.owner_notices", `insert into public.owner_notices (brand_id, kind, key) values ('${shop.brand_id}', 'usage', 'x')`]) {
        await db.query("savepoint s");
        await assert.rejects(() => db.query(sql), (e) => e.code === "42501", `${role}: ${sql}`);
        await db.query("rollback to savepoint s");
      }
      await db.query("rollback");
    }
  } finally {
    for (const brand of [shop.brand_id, quiet.brand_id]) {
      await db.query("delete from public.businesses where brand_id = $1", [brand]);
      await db.query("delete from public.brands where id = $1", [brand]);
    }
    await db.query("delete from auth.users where id in ($1, $2)", [OWNER.id, OTHER.id]);
    await pool.end().catch(() => {});
  }
});
