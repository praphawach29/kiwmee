const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('next/dist/build/swc');

// Compile a dashboard .jsx file; `extra` exposes internal components for the test.
function load(file, extra = '') {
  const filename = path.join(__dirname, file);
  const { code } = transformSync(fs.readFileSync(filename, 'utf8') + extra, {
    filename, jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod.require = (name) => (name.startsWith('.') && !name.endsWith('.mjs') ? {} : Module.prototype.require.call(mod, name));
  mod._compile(code, filename);
  return mod.exports;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('phone tab bar: daily tabs from the role-checked navigation plus "เพิ่มเติม", with the unread badge', async () => {
  const { shopNavigation } = await import('./merchant-navigation.mjs');
  const { MobileTabBar } = load('merchant-mobile.jsx');
  const staff = render(MobileTabBar, { groups: shopNavigation('staff'), active: 'bookings', onSelect() {}, badges: { bookings: 3 }, bookingHref: '/b/x' });
  assert.deepEqual([...staff.matchAll(/<\/span>([^<]+)<\/button>/g)].map((m) => m[1]), ['ภาพรวม', 'การจอง', 'บิล', 'สมาชิก', 'เพิ่มเติม']);
  assert.match(staff, /aria-current="page"[^>]*>.*?การจอง/);
  assert.match(staff, /aria-label="3 รายการใหม่">3</);
  // the settings stay in the closed sheet, and an owner on a settings tab sees "เพิ่มเติม" as current
  const owner = render(MobileTabBar, { groups: shopNavigation('owner'), active: 'team', onSelect() {}, bookingHref: '/b/x' });
  assert.doesNotMatch(owner, /พนักงานและสิทธิ์/);
  assert.match(owner, /aria-current="page" aria-expanded="false">.*?เพิ่มเติม/);
  assert.equal(render(MobileTabBar, { groups: shopNavigation('viewer'), active: null, onSelect() {}, bookingHref: '/b/x' }), '');
});

test('booking actions: one main button, the rest behind ⋯, skipping actions that do not apply', () => {
  const { BookingActions } = load('[slug]/shop-admin-client.jsx', '\nexport { BookingActions };');
  const run = () => {};
  const html = render(BookingActions, { busy: false, actions: [false, { label: 'มาถึงแล้ว', run }, { label: 'เลื่อน', run }, { label: 'ยกเลิก', run, danger: true }] });
  assert.match(html, /class="ad-primary"[^>]*>มาถึงแล้ว</);
  assert.match(html, /aria-label="ตัวเลือกเพิ่มเติม"/);
  assert.match(html, /data-danger="true"[^>]*>ยกเลิก</);
  const forced = render(BookingActions, { busy: true, actions: [{ label: 'เสร็จแล้ว', run }, { label: 'ปิดบิล', run, primary: true }] });
  assert.match(forced, /class="ad-primary" disabled=""[^>]*>ปิดบิล</);
  const single = render(BookingActions, { busy: false, actions: [{ label: 'ปิดบิล', run }] });
  assert.doesNotMatch(single, /<details/);
  assert.equal(render(BookingActions, { busy: false, actions: [false, null] }), '');
});

test('booking link card: the message names the shop and time, with copy, LINE and (when there is a phone) SMS', () => {
  const { ManageLinkCard } = load('[slug]/shop-admin-client.jsx', '\nexport { ManageLinkCard };');
  const props = { shop: { name: 'Bloom' }, link: { path: '/b/bloom/manage/abc', name: 'คุณมาลี', phone: '0812345678', date: '2026-11-03', time: '14:00' }, onClose() {} };
  const html = render(ManageLinkCard, props);
  assert.match(html, /ส่งลิงก์ให้ คุณมาลี/);
  assert.match(html, /นัดของคุณที่ Bloom/);
  assert.match(html, /เวลา 14:00 น\./);
  assert.match(html, /\/b\/bloom\/manage\/abc/);
  assert.match(html, /href="https:\/\/line.me\/R\/share\?text=[^"]*%2Fb%2Fbloom%2Fmanage%2Fabc/);
  assert.match(html, /href="sms:0812345678\?body=/);
  assert.doesNotMatch(render(ManageLinkCard, { ...props, link: { ...props.link, phone: null } }), /sms:/);
});

test('add-on group editor: pick rule, offerings to tick, and each add-on with price, quantity, minutes and what it uses', () => {
  const { AddonGroupEditor, pickRule, emptyAddonGroup } = load('[slug]/shop-admin-client.jsx', '\nexport { AddonGroupEditor, pickRule, emptyAddonGroup };');
  assert.equal(pickRule({ minSelect: 1, maxSelect: 1 }), 'ต้องเลือก 1 อย่าง');
  assert.equal(pickRule({ minSelect: 0, maxSelect: null }), 'เลือกได้หลายอย่าง (ไม่บังคับ)');
  assert.equal(pickRule({ minSelect: 2, maxSelect: null }), 'เลือก 2–ไม่จำกัด อย่าง');
  const catalog = {
    offerings: [{ id: 'o1', name: 'สนาม 1 ชม.', active: true, requirements: [{ kind: 'court' }] }],
    resources: [{ id: 'r1', kind: 'ไม้แบด', name: 'ไม้แบด', active: true }]
  };
  const initial = { ...emptyAddonGroup(), name: 'อุปกรณ์', offeringIds: ['o1'], addons: [{ name: 'เช่าไม้', amount: 50, priceUnit: 'per_unit', maxQuantity: 4, addsMinutes: 0, usesKind: 'ไม้แบด', active: true }] };
  const html = render(AddonGroupEditor, { slug: 's', catalog, initial, onSaved() {}, onClose() {} });
  assert.match(html, /value="อุปกรณ์"/);
  assert.match(html, /<option value="any" selected="">เลือกได้หลายอย่าง/);
  assert.match(html, /checked=""\/>สนาม 1 ชม\./);
  assert.match(html, /value="เช่าไม้"/);
  assert.match(html, /<option value="per_unit" selected="">บาท ต่อชิ้น/);
  assert.match(html, /<option value="ไม้แบด" selected="">ไม้แบด/);
  assert.match(html, /ลูกค้าเห็นตัวเลือกเหล่านี้หลังเลือกเวลา/);
  assert.doesNotMatch(html, /ยังไม่มีไม้แบดที่เปิดอยู่/);
});
