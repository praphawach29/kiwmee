const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('next/dist/build/swc');

function loadComponents() {
  const filename = path.join(__dirname, 'booking-presentation.jsx');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } },
    module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(code, filename);
  return mod.exports;
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

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
