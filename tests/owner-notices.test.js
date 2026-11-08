// B8: what a brand owner hears in LINE about their plan, and linking LINE (src/v2/owner-notices.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const { dueNotices, noticeCard, daysLeft, finishLink, linkAction } = require("../src/v2/owner-notices");

const NOW = new Date("2026-11-08T05:00:00Z"); // 12:00 Bangkok
const DAY = 864e5;
const at = (days) => new Date(NOW.getTime() + days * DAY).toISOString();
const base = (extra = {}) => ({
  brandName: "ร้านทดสอบ",
  plan: "starter",
  cycle: "month",
  validUntil: at(20),
  complimentary: false,
  trial: false,
  autoRenew: true,
  nextPlan: null,
  nextCycle: null,
  graceUntil: null,
  balance: 0,
  period: "2026-11-01",
  usage: { bookings: { used: 0, total: null }, messages: { used: 0, total: 900 }, slips: { used: 0, total: 50 } },
  ...extra
});
const kinds = (list) => list.map((n) => `${n.kind}:${n.key}`);

test("days left round up", () => {
  assert.equal(daysLeft(at(0.5), NOW), 1);
  assert.equal(daysLeft(at(7), NOW), 7);
  assert.equal(daysLeft(at(7.01), NOW), 8);
});

test("a plan more than 7 days from its end, under 80% of everything: nothing to say", () => {
  assert.deepEqual(dueNotices(base(), NOW), []);
  assert.deepEqual(dueNotices(base({ plan: "free", validUntil: null }), NOW), []);
});

test("a short wallet hears it 7, 3 and 1 day before the end, each once (one key per step)", () => {
  const seven = dueNotices(base({ validUntil: at(6.5), balance: 100 }), NOW);
  assert.equal(seven.length, 1);
  assert.equal(seven[0].kind, "expiring");
  assert.match(seven[0].key, /^2026-11-1\d:7$/);
  assert.equal(seven[0].title, "เงินในกระเป๋าไม่พอต่ออายุ");
  assert.match(seven[0].lines.join(" "), /เติมอีก 290 บาท/);
  assert.match(dueNotices(base({ validUntil: at(2.5), balance: 100 }), NOW)[0].key, /:3$/);
  const last = dueNotices(base({ validUntil: at(0.4), balance: 100 }), NOW)[0];
  assert.match(last.key, /:1$/);
  assert.equal(last.tone, "danger");
});

test("a wallet that can pay hears it once; a scheduled change is priced as the next plan", () => {
  const funded = dueNotices(base({ validUntil: at(5), balance: 1000 }), NOW);
  assert.match(funded[0].key, /:funded$/);
  assert.equal(funded[0].title, "แพ็กเกจเริ่มต้นจะต่ออายุอัตโนมัติ");
  assert.match(funded[0].lines[0], /390 บาท/);
  const later = new Date(NOW.getTime() + 3 * DAY); // the same plan end, 2 days left: the same key
  assert.deepEqual(kinds(dueNotices(base({ validUntil: at(5), balance: 1000 }), later)), kinds(funded));
  const yearly = dueNotices(base({ plan: "pro", validUntil: at(5), nextPlan: "starter", nextCycle: "year", balance: 0 }), NOW)[0];
  assert.match(yearly.lines.join(" "), /ต่ออายุเริ่มต้น 1 ปี 3,900 บาท/);
});

test("trial, free period and auto-renew off each say what happens after the end", () => {
  assert.match(dueNotices(base({ plan: "pro", trial: true, complimentary: true, autoRenew: false, validUntil: at(3) }), NOW)[0].title, /ช่วงทดลองแพ็กเกจโปรใกล้หมด/);
  assert.match(dueNotices(base({ plan: "pro", complimentary: true, autoRenew: false, validUntil: at(1) }), NOW)[0].lines[1], /ซื้อแพ็กเกจไว้ล่วงหน้า/);
  assert.match(dueNotices(base({ autoRenew: false, validUntil: at(1) }), NOW)[0].lines[0], /ปิดการต่ออายุอัตโนมัติ/);
  assert.match(dueNotices(base({ nextPlan: "free", validUntil: at(1) }), NOW)[0].lines[0], /แพ็กเกจฟรี/);
});

test("grace days: once per grace end, with what to top up", () => {
  const [grace] = dueNotices(base({ validUntil: at(-1), graceUntil: at(6), balance: 90 }), NOW);
  assert.equal(grace.kind, "grace");
  assert.equal(grace.title, "แพ็กเกจเริ่มต้นหมดแล้ว");
  assert.match(grace.lines.join(" "), /เติมเงินอีก 300 บาท/);
  assert.deepEqual(dueNotices(base({ validUntil: at(-8), graceUntil: at(-1) }), NOW), []); // grace over: free now
});

test("usage: 80% and 100% of this month, once each; 100% also covers 80%; unlimited / none never", () => {
  const warn = dueNotices(base({ usage: { bookings: { used: 41, total: 50 }, messages: { used: 10, total: 100 }, slips: { used: 0, total: 0 } } }), NOW);
  assert.deepEqual(kinds(warn), ["usage:2026-11-01:bookings:80"]);
  assert.equal(warn[0].title, "การจองออนไลน์ ใช้ไป 82%");
  assert.match(warn[0].lines[0], /41 จาก 50 ครั้ง/);
  const full = dueNotices(base({ usage: { bookings: { used: 50, total: 50 }, messages: { used: 900, total: 900 }, slips: { used: 10, total: null } } }), NOW);
  assert.deepEqual(kinds(full), ["usage:2026-11-01:bookings:100", "usage:2026-11-01:messages:100"]);
  assert.deepEqual(full[0].claimAlso, ["2026-11-01:bookings:80"]);
  assert.match(full[1].lines[0], /หยุดส่ง/);
});

test("the LINE card: brand, title, every line, a button only with a link", () => {
  const [notice] = dueNotices(base({ validUntil: at(2), balance: 0 }), NOW);
  const card = noticeCard(notice, { brandName: "ร้านทดสอบ", link: "https://kiwmee.example/dashboard/wallet?brand=x" });
  assert.equal(card.type, "flex");
  assert.match(card.altText, /^ร้านทดสอบ: เงินในกระเป๋าไม่พอต่ออายุ/);
  assert.match(JSON.stringify(card), /Kiwmee · ร้านทดสอบ/);
  assert.equal(card.contents.footer.contents[0].action.label, "เติมเงิน");
  assert.equal(card.contents.footer.contents[0].action.uri, "https://kiwmee.example/dashboard/wallet?brand=x");
  assert.equal(noticeCard(notice, { brandName: "ร้าน", link: null }).contents.footer, undefined);
});

test("finishing a link checks the code and LINE before touching the database", async () => {
  const db = { query: async () => assert.fail("no database yet") };
  const verifyLineToken = async () => ({ sub: `U${"a".repeat(32)}`, name: "เจ้าของ" });
  await assert.rejects(finishLink(db, { code: "short", lineIdToken: "t" }, { verifyLineToken }), (e) => e.status === 400);
  await assert.rejects(finishLink(db, { code: "A".repeat(24) }, { verifyLineToken }), (e) => e.status === 401);
  await assert.rejects(finishLink(db, { code: "A".repeat(24), lineIdToken: "t" }, { verifyLineToken: async () => null }), (e) => e.status === 401);
  await assert.rejects(linkAction("e1000000-0000-4000-8000-0000000000aa", { action: "nope" }), (e) => e.status === 400);
});

test("the routes load; the dashboard one refuses anonymous requests", async () => {
  const { POST } = require("../app/api/dashboard/line-link/route");
  const res = await POST(new Request("http://x/api/dashboard/line-link", { method: "POST", body: "{}" }));
  assert.equal(res.status, 401);
  assert.equal(typeof require("../app/api/line/owner-link/route").POST, "function");
});
