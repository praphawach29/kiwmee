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
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  if (file.includes('shop-admin-client')) mod.require = (name) => name.startsWith('.') ? {} : require(name);
  mod._compile(code, filename);
  return mod.exports;
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

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
  assert.doesNotMatch(html, /type="file"/);
});

test('shop gallery uses a branded empty state and rejects unsafe media', () => {
  const { ShopGallery } = loadComponents();
  const html = render(ShopGallery, { shop: { name: 'JackShop', media: [{ url: 'javascript:alert(1)' }, { url: '//elsewhere.test/a.jpg' }] } });
  assert.match(html, /ยังไม่มีภาพจากร้าน/);
  assert.doesNotMatch(html, /<img|javascript:|elsewhere/);
});

test('offering thumbnail uses its own media and discloses demo illustrations', () => {
  const { OfferingThumbnail } = loadComponents();
  const html = render(OfferingThumbnail, { offering: { name: 'แบดมินตัน', media: [{ url: '/demo-media/badminton.svg', alt: 'ภาพประกอบแบดมินตัน' }] } });
  assert.match(html, /src="\/demo-media\/badminton.svg"/);
  assert.match(html, /alt="ILLUSTRATION/);
  assert.match(html, /bk-media-caption[^>]*>ILLUSTRATION/);
  const empty = render(OfferingThumbnail, { offering: { name: 'ไม่มีภาพ' } });
  assert.match(empty, /ยังไม่มีภาพจากร้าน/);
  assert.doesNotMatch(empty, /<img/);
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
  assert.doesNotMatch(html, /บาท|ยอดรวม/);
});

test('mobile confirmation submits the real booking form and reflects loading readiness', () => {
  const { BookingSubmitBar } = loadComponents();
  const html = render(BookingSubmitBar, { formId: 'booking-customer', disabled: true, busy: true });
  assert.match(html, /type="submit"/);
  assert.match(html, /form="booking-customer"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /กำลังยืนยัน/);
});
