const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('next/dist/build/swc');
const { planCatalog } = require('../../src/v2/plans');

function load() {
  const filename = path.join(__dirname, 'billing-panel.jsx');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (name) => (name === './api.mjs' ? { api: async () => ({}) } : Module.prototype.require.call(mod, name));
  mod._compile(code, filename);
  return mod.exports;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

const DAY = 864e5;
const walletWith = (plan, extra = {}) => ({ catalog: planCatalog(), plan: { effective: plan.effective ?? plan.plan, cycle: 'month', auto_renew: true, ...plan }, balance: 0, planName: '', ...extra });

test('plan cards: every plan from the one table, current and recommended marked, buttons follow quotePlan', () => {
  const { PlanCards } = load();
  const until = new Date(Date.now() + 12 * DAY).toISOString();
  const html = render(PlanCards, { wallet: walletWith({ plan: 'starter', valid_until: until }), cycle: 'month', onPick() {}, onSchedule() {} });
  assert.equal((html.match(/<article class="bl-plan"/g) || []).length, 4);
  assert.match(html, /data-current="true" data-recommended="false"><h3>เริ่มต้น<\/h3>/);
  assert.match(html, /data-recommended="true"><span class="bl-plan-flag">แนะนำ<\/span><h3>โปร<\/h3>/);
  assert.match(html, /<b>890<\/b> บาท\/เดือน/);
  assert.match(html, />ต่ออายุ 1 เดือน</); // the current paid plan renews
  assert.match(html, />อัปเกรด · จ่าย 2\d\d บาท</); // pro: the difference for ~12 of 30 days
  assert.match(html, />ไม่ต่ออายุ · กลับเป็นฟรีรอบหน้า</);
  assert.match(html, /การจองออนไลน์ต่อเดือน<\/span><b>50 ครั้ง<\/b>/);
  assert.match(html, /ระบบสมาชิก: คะแนน รางวัล ระดับ บัตร<\/span><b aria-label="มี">✓<\/b>/);
  const year = render(PlanCards, { wallet: walletWith({ plan: 'starter', valid_until: until }), cycle: 'year', onPick() {}, onSchedule() {} });
  assert.match(year, /<b>8,900<\/b> บาท\/ปี/);
  assert.match(year, />เปลี่ยนเป็นรายปี · /);
});

test('a cheaper plan is set for the next renewal, never bought mid-period', () => {
  const { PlanCards } = load();
  const until = new Date(Date.now() + 10 * DAY).toISOString();
  const html = render(PlanCards, { wallet: walletWith({ plan: 'pro', valid_until: until }), cycle: 'month', onPick() {}, onSchedule() {} });
  assert.doesNotMatch(html, /เลือกแพ็กเกจเริ่มต้น|เลือกแพ็กเกจสมาชิก/);
  assert.equal((html.match(/เปลี่ยนเป็นแพ็กเกจนี้รอบหน้า/g) || []).length, 2);
  const scheduled = render(PlanCards, { wallet: walletWith({ plan: 'pro', valid_until: until, next_plan: 'starter' }), cycle: 'month', onPick() {}, onSchedule() {} });
  assert.match(scheduled, /เริ่มรอบถัดไป/);
});

test('free plans, the trial and the launch offer: buy to keep it after the free days', () => {
  const { PlanCards } = load();
  const free = render(PlanCards, { wallet: walletWith({ plan: 'free', effective: 'free', valid_until: null }), cycle: 'month', onPick() {}, onSchedule() {} });
  assert.match(free, />เลือกแพ็กเกจโปร</);
  assert.match(free, /แพ็กเกจปัจจุบัน/);
  const trial = render(PlanCards, { wallet: walletWith({ plan: 'pro', valid_until: new Date(Date.now() + 9 * DAY).toISOString(), complimentary: true, trial: true }), cycle: 'month', onPick() {}, onSchedule() {} });
  assert.match(trial, />ซื้อล่วงหน้า 890 บาท</);
  assert.match(trial, />เลือกแพ็กเกจเริ่มต้น</); // the free days are not paid: any plan may start
});

test('switching down lists what will be paused', () => {
  const { lostFeatures, limitText } = load();
  const lost = lostFeatures(planCatalog(), 'pro', 'starter');
  assert.ok(lost.includes('ระบบสมาชิก: คะแนน รางวัล ระดับ บัตร'));
  assert.ok(lost.includes('ช่าง / สนาม / ห้อง เหลือ 5'));
  assert.ok(lostFeatures(planCatalog(), 'pro', 'free').includes('ตรวจสลิปอัตโนมัติต่อเดือน: ไม่มี'));
  assert.equal(limitText(null), 'ไม่จำกัด');
  assert.equal(limitText(0), '—');
  assert.equal(limitText(4000, 'ข้อความ'), '4,000 ข้อความ');
});

test('the panel waits for the wallet and says when the shop has no brand', () => {
  const BillingPanel = load().default;
  assert.match(render(BillingPanel, { brandId: 'b1' }), /กำลังโหลด/);
  assert.match(render(BillingPanel, { brandId: null }), /ยังไม่อยู่ในแบรนด์/);
});
