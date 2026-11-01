import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadMediaFile, validateUploadFile, isSafeMediaUrl, createMediaUploader, mediaUploadFormGuard } from './media-upload.mjs';

test('form guard blocks Save and Enter synchronously while pending and cleans up on unmount', () => {
  let listener, message = '', prevented = false, stopped = false, reported = false;
  const form = { addEventListener: (type, fn, capture) => { assert.equal(type, 'submit'); assert.equal(capture, true); listener = fn; }, removeEventListener: (type, fn, capture) => { assert.equal(type, 'submit'); assert.equal(fn, listener); assert.equal(capture, true); listener = null; } };
  const input = { setCustomValidity: (value) => { message = value; }, reportValidity: () => { reported = true; } };
  const guard = mediaUploadFormGuard(form, input);
  guard.setPending(true);
  assert.match(message, /รอ/);
  listener({ preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
  assert.equal(prevented && stopped && reported, true);
  guard.setPending(false);
  assert.equal(message, '');
  listener({ preventDefault: () => assert.fail('save blocked after upload'), stopImmediatePropagation() {} });
  guard.setPending(true);
  guard.dispose();
  assert.equal(message, '');
  assert.equal(listener, null);
});

test('validates supported MIME types and exact 5 MiB size boundary', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    assert.equal(validateUploadFile({ type, size: 5 * 1024 * 1024 }), '');
  }
  for (const type of ['image/svg+xml', 'image/gif', 'image/heic', '', 'text/plain']) {
    assert.match(validateUploadFile({ type, size: 10 }), /JPEG/);
  }
  assert.match(validateUploadFile({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }), /5 MB/);
  assert.ok(validateUploadFile({ type: 'image/png', size: 0 }));
});

test('preview URLs reject scripts, insecure URLs, credentials and traversal', () => {
  for (const url of ['https://cdn.example/a.png', '/demo-media/court.svg']) assert.equal(isSafeMediaUrl(url), true);
  for (const url of ['javascript:alert(1)', 'http://cdn.example/a.png', '//cdn.example/a.png', 'https://user:pass@cdn.example/a', '/demo-media/../secret', '/demo-media/%2e/a', 'https://cdn.example/a b']) assert.equal(isSafeMediaUrl(url), false);
});

test('server errors remain actionable and malformed successful responses never enter draft', async () => {
  const file = new File(['image'], 'shop.png', { type: 'image/png' });
  await assert.rejects(uploadMediaFile('shop', file, { fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'พื้นที่เต็ม' } }) }) }), /พื้นที่เต็ม/);
  for (const data of [{}, { url: 'javascript:alert(1)' }, { url: '/demo-media/a.png' }]) {
    await assert.rejects(uploadMediaFile('shop', file, { fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) }), /ไม่ถูกต้อง/);
  }
  await assert.rejects(uploadMediaFile('shop', file, { fetchImpl: async () => ({ ok: false, json: async () => { throw new Error('HTML'); } }) }), /อัปโหลดไม่สำเร็จ/);
});

test('batch reserves eight slots, ignores duplicate starts, retains per-file failures, and appends to latest draft', async () => {
  let draft = [{ url: 'https://cdn.example/original.png', alt: '' }];
  const uploaded = [], errors = [], pending = [];
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const uploader = createMediaUploader({
    upload: async (file) => { calls++; if (calls === 1) await first; if (file.name === 'bad.png') throw new Error('เครือข่ายขัดข้อง'); return { url: `https://cdn.example/${file.name}`, alt: '' }; },
    getCount: () => draft.length,
    onUploaded: (item) => { draft = [...draft, item]; uploaded.push(item); },
    onState: (id, state) => { if (state.error) errors.push([id, state.error]); },
    onPending: (busy) => pending.push(busy),
  });
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: String(i), file: new File(['img'], i === 1 ? 'bad.png' : `${i}.png`, { type: 'image/png' }) }));
  const batch = uploader.start(rows);
  assert.equal(uploader.busy, true);
  await uploader.start(rows);
  assert.equal(calls, 1);
  draft[0] = { ...draft[0], alt: 'edited while uploading' };
  resolveFirst();
  await batch;
  assert.equal(calls, 7);
  assert.equal(uploaded.length, 6);
  assert.equal(draft.length, 7);
  assert.equal(draft[0].alt, 'edited while uploading');
  assert.equal(errors.length, 3);
  assert.deepEqual(pending, [true, false]);
  await uploader.start([{ id: 'retry', file: rows[0].file }]);
  assert.equal(draft.length, 8);
});

test('dispose aborts and suppresses completion callbacks after unmount', async () => {
  let resolveUpload, signal;
  const states = [];
  const uploader = createMediaUploader({ getCount: () => 0, upload: (_file, options) => { signal = options.signal; return new Promise((resolve) => { resolveUpload = resolve; }); }, onUploaded: () => assert.fail('unmounted draft update'), onState: (...args) => states.push(args), onPending: (...args) => states.push(args) });
  const batch = uploader.start([{ id: 'a', file: new File(['img'], 'a.png', { type: 'image/png' }) }]);
  uploader.dispose();
  const before = states.length;
  assert.equal(signal.aborted, true);
  resolveUpload({ url: 'https://cdn.example/a.png', alt: '' });
  await batch;
  assert.equal(states.length, before);
});

test('uploads the original File as raw binary with same-origin credentials', async () => {
  const file = new File(['image'], 'shop.png', { type: 'image/png' });
  const signal = new AbortController().signal;
  const result = await uploadMediaFile('my-shop', file, { signal, fetchImpl: async (url, init) => {
    assert.equal(url, '/api/dashboard/shops/my-shop/media');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, file);
    assert.deepEqual(init.headers, { 'Content-Type': 'image/png' });
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.signal, signal);
    return { ok: true, json: async () => ({ data: { url: 'https://cdn.example/shop.png', alt: '' } }) };
  } });
  assert.deepEqual(result, { url: 'https://cdn.example/shop.png', alt: '' });
});
