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
  assert.deepEqual([...staff.matchAll(/<\/span>([^<]+)<\/button>/g)].map((m) => m[1]), ['ภาพรวม', 'การจอง', 'บิล', 'เพิ่มเติม']);
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
