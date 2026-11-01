const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('next/dist/build/swc');

function loadEditor() {
  const filename = path.join(__dirname, 'media-editor.jsx');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' },
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(code, filename);
  return mod.exports.default;
}

test('media editor exposes accessible multi-file chooser, public disclosure, safe previews and explicit save', () => {
  const Editor = loadEditor();
  const html = renderToStaticMarkup(React.createElement(Editor, { slug: 'shop', label: 'ภาพร้าน', value: [{ url: 'https://cdn.example/a.png', alt: 'หน้าร้าน' }, { url: 'javascript:alert(1)', alt: '' }], onChange() {} }));
  assert.match(html, /type="file"/);
  assert.match(html, /multiple=""/);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /สาธารณะ/);
  assert.match(html, /สลิป/);
  assert.match(html, /กดบันทึก/);
  assert.match(html, /src="https:\/\/cdn.example\/a.png"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(html, /src="javascript:/);
  assert.match(html, /\+ เพิ่ม URL ภาพ/);
});

test('media editor disables gallery additions at eight and during an existing save', () => {
  const Editor = loadEditor();
  for (const props of [{ value: Array.from({ length: 8 }, () => ({ url: 'https://cdn.example/a.png', alt: '' })) }, { value: [], disabled: true }]) {
    const html = renderToStaticMarkup(React.createElement(Editor, { slug: 'shop', label: 'ภาพร้าน', onChange() {}, ...props }));
    assert.match(html, /disabled="">\+ เพิ่ม URL ภาพ/);
    assert.match(html, /type="file"[^>]*disabled=""/);
  }
});
