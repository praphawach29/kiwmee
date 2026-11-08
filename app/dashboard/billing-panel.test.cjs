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

test('plan cards: every plan from the one table, current and recommended marked, free has no buy button', () => {
  const { PlanCards } = load();
  const html = render(PlanCards, { catalog: planCatalog(), current: 'starter', onPick() {} });
  assert.equal((html.match(/<article class="bl-plan"/g) || []).length, 4);
  assert.match(html, /data-current="true" data-recommended="false"><h3>เริ่มต้น<\/h3>/);
  assert.match(html, /data-recommended="true"><span class="bl-plan-flag">แนะนำ<\/span><h3>โปร<\/h3>/);
  assert.match(html, /<b>890<\/b> บาท\/เดือน/);
  assert.match(html, />ต่ออายุ 1 เดือน</); // the current paid plan renews
  assert.match(html, />เลือกแพ็กเกจโปร</);
  assert.doesNotMatch(html, /เลือกแพ็กเกจฟรี/);
  assert.match(html, /การจองออนไลน์ต่อเดือน<\/span><b>50 ครั้ง<\/b>/);
  assert.match(html, /ไม่จำกัด/);
  assert.match(html, /ระบบสมาชิก: คะแนน รางวัล ระดับ บัตร<\/span><b aria-label="มี">✓<\/b>/);
});

test('limits read as people say them, and buying a month extends from the later of today or the expiry', () => {
  const { limitText, purchaseOutcome } = load();
  assert.equal(limitText(null), 'ไม่จำกัด');
  assert.equal(limitText(0), '—');
  assert.equal(limitText(4000, 'ข้อความ'), '4,000 ข้อความ');
  const now = new Date('2026-11-08T00:00:00Z');
  const day = 24 * 3600 * 1000;
  assert.equal(purchaseOutcome({ effective: 'free', valid_until: null }, 'pro', now).until.getTime(), now.getTime() + 30 * day);
  const later = purchaseOutcome({ effective: 'pro', valid_until: '2026-11-20T00:00:00Z' }, 'pro', now);
  assert.equal(later.until.toISOString(), '2026-12-20T00:00:00.000Z');
  assert.equal(later.switching, false);
  assert.equal(purchaseOutcome({ effective: 'starter', valid_until: '2026-11-20T00:00:00Z' }, 'pro', now).switching, true);
});

test('the panel waits for the wallet and says when the shop has no brand', () => {
  const BillingPanel = load().default;
  assert.match(render(BillingPanel, { brandId: 'b1' }), /กำลังโหลด/);
  assert.match(render(BillingPanel, { brandId: null }), /ยังไม่อยู่ในแบรนด์/);
});

test('a cheaper plan shows "when the current plan ends" instead of a buy button while the dearer one runs', () => {
  const { PlanCards } = load();
  const html = render(PlanCards, { catalog: planCatalog(), current: 'pro', validUntil: new Date(Date.now() + 10 * 864e5).toISOString(), onPick() {} });
  assert.doesNotMatch(html, /เลือกแพ็กเกจเริ่มต้น|เลือกแพ็กเกจสมาชิก/);
  assert.equal((html.match(/ได้เมื่อแพ็กเกจปัจจุบันหมดอายุ/g) || []).length, 2);
  assert.match(html, />ต่ออายุ 1 เดือน</);
});
