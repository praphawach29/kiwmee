const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('next/dist/build/swc');

function loadComponents(file = 'booking-presentation.jsx') {
  const filename = path.join(__dirname, file);
  const source = fs.readFileSync(filename, 'utf8') + (file.includes('shop-admin-client') ? '\nexport { ResourceEditor, ResourcesTab, emptyResource, ReadOnly };' : file === 'booking-v2-client.jsx' ? '\nexport { OptionBody, DateStrip, TimeTabs };' : '');
  const { code } = transformSync(source, {
    filename,
    jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  if (file.includes('shop-admin-client')) mod.require = (name) => name === '../media-editor.jsx' ? loadComponents('../../dashboard/media-editor.jsx') : name === '../media-upload.mjs' ? require(path.join(__dirname, '../../dashboard/media-upload.mjs')) : name.includes('/src/v2/') ? require(path.resolve(path.dirname(filename), name)) : name.startsWith('.') ? {} : require(name);
  else mod.require = (name) => name.endsWith('.jsx') ? loadComponents(path.relative(__dirname, path.resolve(path.dirname(filename), name))) : Module.prototype.require.call(mod, name);
  mod._compile(code, filename);
  return mod.exports;
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('booking resource option uses catalog resource media, never option or offering photos', () => {
  const { OptionBody } = loadComponents('booking-v2-client.jsx');
  const props = { ask: 'resource', option: { value: 'a', label: 'สนาม A', media: [{ url: 'https://example.com/wrong.jpg' }] }, resource: { id: 'a', name: 'สนาม A', media: [{ url: 'https://example.com/resource.jpg', alt: 'สนาม A' }] }, offering: { media: [{ url: 'https://example.com/offering.jpg' }] }, resourceWord: 'สนาม' };
  const html = render(OptionBody, props);
  assert.match(html, /src="https:\/\/example.com\/resource.jpg"/);
  assert.doesNotMatch(html, /wrong.jpg|offering.jpg/);
  const any = render(OptionBody, { ...props, option: { value: null } });
  assert.match(any, /สนามใดก็ได้/);
  assert.doesNotMatch(any, /<img/);
  const source = fs.readFileSync(path.join(__dirname, 'booking-v2-client.jsx'), 'utf8');
  assert.match(source, /resource=\{resources.get\(o.value\)\}/);
});

test('resource choice renders only the matched resource media with accessible alt', () => {
  const { ResourceChoice } = loadComponents();
  const html = render(ResourceChoice, { resource: { name: 'สนาม A', media: [{ url: 'https://example.com/court.jpg', alt: 'สนาม A ในร่ม' }] }, label: 'สนาม A', resourceWord: 'สนาม' });
  assert.match(html, /src="https:\/\/example.com\/court.jpg"/);
  assert.match(html, /alt="สนาม A ในร่ม"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  const unnamed = render(ResourceChoice, { resource: { name: 'ช่างแนน', media: [{ url: 'https://example.com/staff.jpg', alt: '' }] }, label: 'ช่างแนน' });
  assert.match(unnamed, /alt="ช่างแนน"/);
});

test('resource choice has honest missing-image and system-assigned states', () => {
  const { ResourceChoice } = loadComponents();
  for (const media of [undefined, [], [{ url: 'javascript:alert(1)' }]]) {
    const html = render(ResourceChoice, { resource: { name: 'สนาม A', media }, label: 'สนาม A' });
    assert.match(html, /class="bk-avatar" aria-hidden="true">A</);
    assert.match(html, /สนาม A/);
    assert.doesNotMatch(html, /<img|ยังไม่มีภาพ/);
  }
  const any = render(ResourceChoice, { any: true, resourceWord: 'สนาม', resource: { name: 'สนาม A', media: [{ url: 'https://example.com/court.jpg' }] } });
  assert.match(any, /สนามใดก็ได้/);
  assert.match(any, /ระบบเลือกที่ว่างให้/);
  assert.doesNotMatch(any, /<img|สนาม A|ยังไม่มีภาพ/);
});

test('resource editor initializes empty media and retains existing gallery in the shared upload editor', () => {
  const { ResourceEditor, emptyResource, ReadOnly } = loadComponents('../../dashboard/[slug]/shop-admin-client.jsx');
  const catalog = { shop: { kind: 'court' }, resources: [], offerings: [], hours: Array.from({ length: 7 }, () => ({ isOpen: true, open: '09:00', close: '18:00' })), timeOff: [] };
  assert.deepEqual(emptyResource(catalog).media, []);
  const initial = { ...emptyResource(catalog), name: 'สนาม A', media: [{ url: 'https://example.com/existing.jpg', alt: 'รูปเดิม' }] };
  const props = { slug: 'my-shop', catalog, initial, onSaved() {}, onClose() {} };
  const html = render(ResourceEditor, props);
  assert.match(html, /ภาพช่าง \/ สนาม \/ ห้อง/);
  assert.match(html, /value="https:\/\/example.com\/existing.jpg"/);
  assert.match(html, /value="รูปเดิม"/);
  assert.match(html, /type="file"/);
  assert.match(html, /\+ เพิ่ม URL ภาพ/);
  const readOnly = renderToStaticMarkup(React.createElement(ReadOnly.Provider, { value: true }, React.createElement(ResourceEditor, props)));
  assert.doesNotMatch(readOnly, /type="file"|\+ เพิ่ม URL ภาพ/);
  const source = fs.readFileSync(path.join(__dirname, '../../dashboard/[slug]/shop-admin-client.jsx'), 'utf8');
  assert.match(source, /<MediaEditor slug=\{slug\} disabled=\{save.busy\} label="ภาพช่าง \/ สนาม \/ ห้อง" value=\{r.media \?\? \[\]\} onChange=\{\(media\) => set\(\{ media \}\)\}/);
});

test('resource list shows its saved thumbnail without pretending an empty gallery has a photo', () => {
  const { ResourcesTab } = loadComponents('../../dashboard/[slug]/shop-admin-client.jsx');
  const html = render(ResourcesTab, { slug: 'shop', catalog: { resources: [{ id: 'a', name: 'สนาม A', active: true, kind: 'court', offeringIds: [], media: [{ url: 'https://example.com/a.jpg', alt: 'สนาม A ในร่ม' }] }, { id: 'b', name: 'สนาม B', active: true, kind: 'court', offeringIds: [] }] }, onSaved() {} });
  assert.match(html, /src="https:\/\/example.com\/a.jpg"/);
  assert.match(html, /alt="สนาม A ในร่ม"/);
  assert.match(html, /ยังไม่มีภาพ/);
  assert.equal((html.match(/<img /g) || []).length, 1);
});

test('manage resource summary shows provided media and preserves names for older payloads', () => {
  const { ResourceSummary } = loadComponents();
  const html = render(ResourceSummary, { resources: [{ id: 'a', name: 'สนาม A', media: [{ url: 'https://example.com/a.jpg', alt: 'สนาม A' }] }, { id: 'b', name: 'สนาม B' }] });
  assert.match(html, /src="https:\/\/example.com\/a.jpg"/);
  assert.match(html, /สนาม B/);
  assert.equal((html.match(/<img /g) || []).length, 1);
});

test('resource image failure removes the broken image and exposes a readable fallback', () => {
  const { MediaImage } = loadComponents();
  const original = React.useState;
  const { useRef, useEffect } = React;
  let state = 'loading';
  React.useState = () => [state, (next) => { state = next; }];
  React.useRef = () => ({ current: null });
  React.useEffect = () => {};
  try {
    const props = { item: { url: 'https://example.com/broken.jpg', alt: 'สนาม A' }, name: 'สนาม A' };
    const tree = MediaImage(props);
    tree.props.children[0].props.onError();
    const html = renderToStaticMarkup(MediaImage(props));
    assert.match(html, /โหลดภาพไม่สำเร็จ/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /<img/);
  } finally {
    React.useState = original;
    Object.assign(React, { useRef, useEffect });
  }
});

test('shop gallery renders supplied media with explicit illustration disclosure', () => {
  const { ShopGallery } = loadComponents();
  const html = render(ShopGallery, { shop: { name: 'JackShop', media: [{ url: '/demo-media/tennis.svg', alt: 'เทนนิส' }, { url: 'https://example.com/real.jpg', alt: 'ภาพโดยเจ้าของร้าน' }] } });
  assert.match(html, /src="\/demo-media\/tennis.svg"/);
  assert.match(html, /alt="ILLUSTRATION[^\"]*เทนนิส/);
  assert.match(html, /ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="ดูภาพที่ 2/);
});

test('owner media editor retains URLs and alt labels until explicit form save', () => {
  const { MediaEditor } = loadComponents('../../dashboard/[slug]/shop-admin-client.jsx');
  const html = render(MediaEditor, { value: [{ url: 'https://example.com/photo.jpg', alt: 'ภาพร้าน' }], onChange() {}, label: 'ภาพร้าน' });
  assert.match(html, /value="https:\/\/example.com\/photo.jpg"/);
  assert.match(html, /value="ภาพร้าน"/);
  assert.match(html, /คำอธิบายภาพ/);
  assert.match(html, /type="button"/);
  assert.match(html, /HTTPS/);
  assert.match(html, /type="file"/);
});

test('shop gallery shows nothing without safe media (the header already names the shop)', () => {
  const { ShopGallery } = loadComponents();
  const html = render(ShopGallery, { shop: { name: 'JackShop', media: [{ url: 'javascript:alert(1)' }, { url: '//elsewhere.test/a.jpg' }] } });
  assert.equal(html, '');
});

test('offering thumbnail uses its own media and discloses demo illustrations', () => {
  const { OfferingThumbnail } = loadComponents();
  const html = render(OfferingThumbnail, { offering: { name: 'แบดมินตัน', media: [{ url: '/demo-media/badminton.svg', alt: 'ภาพประกอบแบดมินตัน' }] } });
  assert.match(html, /src="\/demo-media\/badminton.svg"/);
  assert.match(html, /alt="ILLUSTRATION/);
  assert.match(html, /bk-media-caption[^>]*>ภาพประกอบ/);
  const empty = render(OfferingThumbnail, { offering: { name: 'ไม่มีภาพ' } });
  assert.equal(empty, '');
});

test('gallery caps media at eight and URL editor disables additional entries', () => {
  const media = Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}.jpg`, alt: `ภาพ ${i}` }));
  const { ShopGallery } = loadComponents();
  const gallery = render(ShopGallery, { shop: { name: 'JackShop', media } });
  assert.equal((gallery.match(/aria-pressed=/g) || []).length, 8);
  const { MediaEditor } = loadComponents('../../dashboard/[slug]/shop-admin-client.jsx');
  const editor = render(MediaEditor, { value: media.slice(0, 8), onChange() {}, label: 'ภาพร้าน' });
  assert.match(editor, /disabled="">\+ เพิ่ม URL ภาพ/);
  assert.equal((editor.match(/คำอธิบายภาพ/g) || []).length, 8);
});

test('shop identity uses the actual shop name without pretending media exists', () => {
  const { ShopHeader } = loadComponents();
  const html = render(ShopHeader, { shop: { name: 'สนามจริง' }, subtitle: 'จองคิวออนไลน์' });
  assert.match(html, /สนามจริง/);
  assert.match(html, /จองคิวออนไลน์/);
  assert.doesNotMatch(html, /<img|rating|gallery/);
});

test('progress groups the server-driven choices rather than imposing a service/date order', () => {
  const { BookingProgress } = loadComponents();
  for (const phase of ['selection', 'customer', 'complete']) {
    const html = render(BookingProgress, { phase });
    assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
    assert.match(html, /เลือกคิว/);
    assert.match(html, /ข้อมูลผู้จอง/);
    assert.match(html, /ยืนยัน/);
  }

  const completed = render(BookingProgress, { phase: 'complete' });
  assert.equal((completed.match(/data-done="true"/g) || []).length, 3);
  assert.equal((completed.match(/aria-current="step"/g) || []).length, 1);
  assert.match(completed, /data-done="true"><span aria-hidden="true">✓<\/span>/);
});

test('review renders only supplied selections and makes each selection editable', () => {
  const { BookingReview } = loadComponents();
  const html = render(BookingReview, {
    items: [{ step: 'party', label: 'จำนวนคน', value: '4 คน' }, { step: 'resource', label: 'สนาม', value: 'สนาม A' }],
    onEdit() {}, busy: true,
  });
  assert.match(html, /4 คน/);
  assert.match(html, /สนาม A/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.match(html, /aria-label="เปลี่ยนจำนวนคน: 4 คน"/);
  assert.doesNotMatch(html, /บาท|ยอดรวม/);
  const priced = render(BookingReview, { items: [], onEdit() {}, busy: false, price: { label: 'ราคาเริ่มต้น', value: 'เริ่ม 300 บาท' } });
  assert.match(priced, /ราคาเริ่มต้น/);
  assert.match(priced, /เริ่ม 300 บาท/);
});

test('mobile confirmation submits the real booking form and reflects loading readiness', () => {
  const { BookingSubmitBar } = loadComponents();
  const html = render(BookingSubmitBar, { formId: 'booking-customer', disabled: true, busy: true });
  assert.match(html, /type="submit"/);
  assert.match(html, /form="booking-customer"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /กำลังยืนยัน/);
  const ready = render(BookingSubmitBar, { formId: 'booking-customer', disabled: false, busy: false, price: '450 บาท' });
  assert.match(ready, /ยืนยันการจอง · 450 บาท/);
  assert.doesNotMatch(render(BookingSubmitBar, { formId: 'f', disabled: false, busy: false }), /บาท/);
});

test('times are grouped into morning, afternoon and evening, keeping server order and dropping empty parts', () => {
  const { groupTimes } = loadComponents();
  const groups = groupTimes([{ value: '10:00' }, { value: '11:45' }, { value: '12:00' }, { value: '16:59' }, { value: '17:00' }]);
  assert.deepEqual(groups.map((g) => [g.label, g.options.map((o) => o.value)]), [
    ['ช่วงเช้า', ['10:00', '11:45']], ['ช่วงบ่าย', ['12:00', '16:59']], ['ช่วงเย็น', ['17:00']],
  ]);
  assert.deepEqual(groupTimes([{ value: '18:30' }]).map((g) => g.key), ['evening']);
});

test('date picker and time slots show the Stitch date strip and every available period together', () => {
  const { DateStrip, TimeTabs } = loadComponents('booking-v2-client.jsx');
  const dates = render(DateStrip, {
    options: [{ value: '2026-11-12', available: true }, { value: '2026-11-13', available: false, reason: 'FULLY_BOOKED' }],
    today: '2026-11-12',
    optionProps: (o) => ({ type: 'button', className: 'bk-option', 'data-value': o.value, disabled: !o.available })
  });
  assert.match(dates, /class="bk-date-strip"/);
  assert.match(dates, /data-value="2026-11-12"/);
  assert.match(dates, /data-value="2026-11-13"[^>]*disabled=""/);

  const times = render(TimeTabs, {
    options: [{ value: '09:00', available: true }, { value: '13:30', available: true }, { value: '18:00', available: true }],
    optionButton: (o) => React.createElement('button', { type: 'button', key: o.value }, o.value)
  });
  for (const label of ['เวลาช่วงเช้า', 'เวลาช่วงบ่าย', 'เวลาช่วงเย็น']) assert.match(times, new RegExp(`aria-label="${label}"`));
  assert.equal((times.match(/ว่าง 1 เวลา/g) || []).length, 3);
  assert.doesNotMatch(times, /role="tab"/);
});

test('initials skip the kind word and keep a Thai leading vowel with its consonant', () => {
  const { initial } = loadComponents();
  assert.equal(initial('ช่างแนน'), 'แน');
  assert.equal(initial('ช่างบี'), 'บ');
  assert.equal(initial('สนาม A'), 'A');
  assert.equal(initial('ช่าง'), 'ช');
  assert.equal(initial(''), '◇');
});
