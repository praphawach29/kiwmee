// LINE booking cards (src/v2/line-notify.js): the Flex message, the link, and pushing it — no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bookingCard, manageLink, pushLine } = require("../src/v2/line-notify");
const { clearCache } = require("../src/v2/platform-settings");

const shop = { name: "QCourt Badminton", timezone: "Asia/Bangkok" };
const booking = {
  offering: "เช่าสนาม",
  startAt: "2026-11-05T11:00:00.000Z", // 18:00 in Bangkok
  endAt: "2026-11-05T13:00:00.000Z",
  resources: ["สนาม 2"],
  addons: [{ name: "เช่าไม้", quantity: 2 }],
  total: 500,
  deposit: null
};
const texts = (node) => (node && typeof node === "object" ? [node.text, node.altText, node.action?.label, node.action?.uri, ...Object.values(node).flatMap(texts)].filter((t) => typeof t === "string") : []);
const noDb = { query: async () => { throw new Error("no database in unit tests"); } };

test("a booked card: shop, offering, day and time in the shop's zone, extras, price, and the button to the booking", () => {
  const card = bookingCard({ kind: "booked", shop, booking, link: "https://liff.line.me/1-x/qcourt/manage/T" });
  assert.equal(card.type, "flex");
  assert.match(card.altText, /^จองสำเร็จ · QCourt Badminton · วันพฤหัสบดีที่ 5 พฤศจิกายน 2569 18:00–20:00 น\.$/);
  const all = texts(card.contents);
  for (const t of ["จองสำเร็จ", "QCourt Badminton", "เช่าสนาม", "18:00–20:00 น.", "สนาม 2", "เช่าไม้ ×2", "500 บาท", "ดู เลื่อน หรือยกเลิกนัด", "https://liff.line.me/1-x/qcourt/manage/T"]) {
    assert.ok(all.some((x) => x.includes(t)), t);
  }
});

test("a held card asks for the transfer by its deadline; no link = no button", () => {
  const card = bookingCard({ kind: "held", shop, booking: { ...booking, deposit: { due: 200, holdExpiresAt: "2026-11-02T10:30:00.000Z" } }, link: null });
  const all = texts(card.contents);
  assert.ok(all.includes("กันคิวไว้ให้แล้ว"));
  assert.ok(all.some((t) => t.includes("โอนมัดจำ 200 บาท ภายใน 17:30 น.")));
  assert.equal(card.contents.footer, undefined);
});

test("the button opens the booking inside LINE when there is a LIFF app, else on the site", async () => {
  clearCache();
  assert.equal(await manageLink(noDb, { slug: "qcourt", token: "T", origin: "https://kiwmee.example" }, { env: { NEXT_PUBLIC_LIFF_ID: "2010969802-QiiDBSxa" } }), "https://liff.line.me/2010969802-QiiDBSxa/qcourt/manage/T");
  clearCache();
  assert.equal(await manageLink(noDb, { slug: "qcourt", token: "T", origin: "https://kiwmee.example" }, { env: {} }), "https://kiwmee.example/b/qcourt/manage/T");
  assert.equal(await manageLink(noDb, { slug: "qcourt", token: null }), null);
  clearCache();
});

test("pushing: the saved token, a retry key, and a reason instead of an error when it cannot be sent", async () => {
  const to = `U${"a".repeat(32)}`;
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  clearCache();
  assert.deepEqual(await pushLine(noDb, to, [{ type: "text", text: "hi" }], { fetchImpl: ok, env: { LINE_CHANNEL_ACCESS_TOKEN: "tok" } }), { sent: true, status: 200 });
  assert.equal(calls[0].url, "https://api.line.me/v2/bot/message/push");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.match(calls[0].init.headers["x-line-retry-key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { to, messages: [{ type: "text", text: "hi" }] });

  const notFriend = async () => ({ ok: false, status: 400 });
  assert.deepEqual(await pushLine(noDb, to, [], { fetchImpl: notFriend, env: { LINE_CHANNEL_ACCESS_TOKEN: "tok" } }), { sent: false, status: 400, reason: "LINE_REFUSED" });
  const down = async () => { throw new Error("ECONNRESET"); };
  assert.deepEqual(await pushLine(noDb, to, [], { fetchImpl: down, env: { LINE_CHANNEL_ACCESS_TOKEN: "tok" } }), { sent: false, reason: "LINE_UNAVAILABLE" });
  clearCache();
  assert.deepEqual(await pushLine(noDb, to, [], { fetchImpl: ok, env: {} }), { sent: false, reason: "NO_TOKEN" });
  assert.deepEqual(await pushLine(noDb, "not-a-user", [], { fetchImpl: ok, env: {} }), { sent: false, reason: "NO_LINE_USER" });
  clearCache();
});
