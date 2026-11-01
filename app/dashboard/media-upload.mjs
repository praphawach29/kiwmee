export const MAX_MEDIA = 8;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp';

export function validateUploadFile(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file?.type)) return 'เลือกเฉพาะไฟล์ JPEG, PNG หรือ WebP (ไม่รองรับ SVG, GIF หรือ HEIC)';
  if (!Number.isFinite(file.size) || file.size <= 0) return 'ไฟล์ภาพว่างหรืออ่านไม่ได้';
  return file.size > MAX_FILE_BYTES ? 'ไฟล์ใหญ่เกิน 5 MB กรุณาลดขนาดภาพ' : '';
}

// Match the gallery policy without fetching or proxying owner URLs.
export function isSafeMediaUrl(url) {
  if (typeof url !== 'string' || !url.length || url.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(url)) return false;
  if (url.startsWith('/demo-media/')) return /^\/demo-media\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(url);
  if (!/^https:\/\/(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?(?:[/?#]|$)/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch { return false; }
}

export async function uploadMediaFile(slug, file, { signal, fetchImpl = fetch } = {}) {
  const invalid = validateUploadFile(file);
  if (invalid) throw new Error(invalid);
  const response = await fetchImpl(`/api/dashboard/shops/${encodeURIComponent(slug)}/media`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file, signal,
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('อัปโหลดไม่สำเร็จ เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ กรุณาลองอีกครั้ง'); }
  if (!response.ok) throw new Error(payload?.error?.message || 'อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง');
  if (!isSafeMediaUrl(payload?.data?.url) || !payload.data.url.startsWith('https://')) throw new Error('เซิร์ฟเวอร์ส่ง URL ภาพไม่ถูกต้อง กรุณาลองอีกครั้ง');
  return { url: payload.data.url, alt: '' };
}

// Constraint validation handles native Save/Enter; capture also guards requestSubmit
// and synthetic submit events before the containing React handler can persist.
export function mediaUploadFormGuard(form, input) {
  let pending = false;
  const blockSubmit = (event) => {
    if (!pending) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input?.reportValidity();
  };
  form?.addEventListener('submit', blockSubmit, true);
  return {
    setPending(value) {
      pending = value;
      input?.setCustomValidity(value ? 'กรุณารอให้อัปโหลดภาพเสร็จก่อนบันทึก' : '');
    },
    dispose() {
      input?.setCustomValidity('');
      form?.removeEventListener('submit', blockSubmit, true);
    },
  };
}

// Reserve capacity synchronously. Only one batch runs at a time; completions
// read the current draft instead of capturing its value when a batch starts.
export function createMediaUploader({ upload, getCount, onUploaded, onState, onPending }) {
  let busy = false;
  let disposed = false;
  let controller;
  return {
    get busy() { return busy; },
    dispose() { disposed = true; controller?.abort(); },
    async start(rows) {
      if (busy || disposed || !rows.length) return;
      busy = true;
      controller = new AbortController();
      onPending(true);
      try {
        let slots = Math.max(0, MAX_MEDIA - getCount());
        const accepted = [];
        for (const row of rows) {
          const error = validateUploadFile(row.file) || (slots <= 0 ? 'เพิ่มได้สูงสุด 8 ภาพ กรุณาลบภาพก่อนลองใหม่' : '');
          if (error) onState(row.id, { status: 'error', error });
          else { slots--; accepted.push(row); onState(row.id, { status: 'queued', error: '' }); }
        }
        for (const row of accepted) {
          if (disposed) break;
          onState(row.id, { status: 'uploading', error: '' });
          try {
            const media = await upload(row.file, { signal: controller.signal });
            if (disposed) break;
            if (getCount() >= MAX_MEDIA) throw new Error('เพิ่มได้สูงสุด 8 ภาพ กรุณาลบภาพก่อนลองใหม่');
            onUploaded(media);
            onState(row.id, { status: 'success', error: '' });
          } catch (error) {
            if (disposed) break;
            onState(row.id, { status: 'error', error: error.message || 'อัปโหลดไม่สำเร็จ ตรวจสอบเครือข่ายแล้วลองใหม่' });
          }
        }
      } finally {
        busy = false;
        if (!disposed) onPending(false);
      }
    },
  };
}
