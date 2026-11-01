"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { createMediaUploader, isSafeMediaUrl, MAX_MEDIA, MEDIA_ACCEPT, mediaUploadFormGuard, uploadMediaFile, validateUploadFile } from './media-upload.mjs';

function MediaPreview({ src, alt }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="ad-media-preview ad-muted" role="status">แสดงตัวอย่างภาพไม่ได้ · ตรวจสอบลิงก์หรือลองภาพอื่น</p> :
    <img className="ad-media-preview" src={src} alt={alt || 'ตัวอย่างภาพ'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function MediaEditor({ slug, value = [], onChange, label, disabled = false }) {
  const id = useId();
  const root = useRef(null);
  const validity = useRef(null);
  const uploader = useRef(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const previews = useRef(new Map());
  const sequence = useRef(0);
  const [rows, setRows] = useState([]);
  const [pending, setPending] = useState(false);
  const change = (next) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };

  useEffect(() => {
    const guard = validity.current;
    const form = root.current?.closest('form');
    const formGuard = mediaUploadFormGuard(form, guard);
    const client = createMediaUploader({
      upload: (file, options) => uploadMediaFile(slug, file, options),
      getCount: () => latest.current.value.length,
      onUploaded: (media) => change([...latest.current.value, media]),
      onState: (rowId, state) => setRows((current) => current.map((row) => row.id === rowId ? { ...row, ...state } : row)),
      onPending: (busy) => {
        // Set validity immediately, not after React renders, to close the click/Enter race.
        formGuard.setPending(busy);
        setPending(busy);
      },
    });
    uploader.current = client;
    return () => {
      client.dispose();
      formGuard.dispose();
      for (const url of previews.current.values()) URL.revokeObjectURL(url);
      previews.current.clear();
    };
  }, [slug]);

  const dismiss = (rowId) => {
    const url = previews.current.get(rowId);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(rowId);
    setRows((current) => current.filter((row) => row.id !== rowId));
  };
  const selectFiles = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (disabled || uploader.current?.busy || !files.length) return;
    const next = files.map((file) => {
      const rowId = `${id}-${++sequence.current}`;
      let preview = '';
      if (!validateUploadFile(file)) {
        preview = URL.createObjectURL(file);
        previews.current.set(rowId, preview);
      }
      return { id: rowId, file, preview, status: 'queued', error: '' };
    });
    setRows((current) => [...current, ...next]);
    void uploader.current?.start(next);
  };
  const update = (index, patch) => change(latest.current.value.map((item, i) => i === index ? { ...item, ...patch } : item));

  return <fieldset className="ad-media-editor" ref={root}>
    <legend>{label} ({value.length}/{MAX_MEDIA})</legend>
    <p id={`${id}-help`} className="ad-muted">เลือกได้หลายไฟล์ JPEG, PNG หรือ WebP ไฟล์ละไม่เกิน 5 MB · รวมสูงสุด 8 ภาพ · ภาพแรกเป็นภาพหลัก หรือใส่ URL แบบ HTTPS / เส้นทาง /demo-media/</p>
    <p id={`${id}-public`} className="ad-media-disclosure">ไฟล์ที่อัปโหลดเป็นสาธารณะทันที แม้ยังไม่กดบันทึก · ห้ามอัปโหลดข้อมูลส่วนตัวลูกค้า ภาพสลิป หรือเอกสารอ่อนไหว</p>
    <label className="ad-field" htmlFor={`${id}-files`}>เลือกภาพจากเครื่อง
      <input id={`${id}-files`} type="file" multiple accept={MEDIA_ACCEPT} disabled={disabled || pending || value.length >= MAX_MEDIA || !slug} aria-describedby={`${id}-help ${id}-public`} onChange={selectFiles} />
    </label>
    <input ref={validity} className="ad-media-validity" type="text" value="" onChange={() => {}} tabIndex={-1} aria-label="สถานะการอัปโหลดภาพ" />
    <div role="status" aria-live="polite">{pending ? 'กำลังอัปโหลดภาพ กรุณารอจนเสร็จก่อนบันทึก (ไม่แสดงเปอร์เซ็นต์)' : rows.some((row) => row.status === 'success') ? 'อัปโหลดเสร็จแล้ว ภาพที่สำเร็จอยู่ในรายการด้านล่าง รอกดบันทึก' : ''}</div>
    {rows.length > 0 && <ul className="ad-media-uploads" aria-label="รายการอัปโหลด" aria-busy={pending}>
      {rows.map((row) => <li key={row.id} className="ad-media-upload">
        {row.preview && <MediaPreview key={row.preview} src={row.preview} alt={`ตัวอย่าง ${row.file.name}`} />}
        <div className="ad-media-upload-detail">
          <strong>{row.file.name}</strong>
          {row.status === 'uploading' && <><span>กำลังอัปโหลด…</span><progress aria-label={`กำลังอัปโหลด ${row.file.name}`} /></>}
          {row.status === 'queued' && <span>รออัปโหลด</span>}
          {row.status === 'success' && <span className="ad-ok">อัปโหลดแล้ว · รอกดบันทึก</span>}
          {row.error && <p className="ad-error" role="alert">{row.error}</p>}
          <div className="ad-row ad-wrap">
            {row.status === 'error' && <button type="button" className="ad-secondary" disabled={disabled || pending || value.length >= MAX_MEDIA} onClick={() => { if (!disabled) void uploader.current?.start([row]); }}>ลองอีกครั้ง<span className="ad-media-sr-only"> {row.file.name}</span></button>}
            {['error', 'success'].includes(row.status) && <button type="button" className="ad-link" onClick={() => dismiss(row.id)}>ปิดรายการ<span className="ad-media-sr-only"> {row.file.name}</span></button>}
          </div>
        </div>
      </li>)}
    </ul>}
    {value.length === 0 && <p className="ad-muted">ยังไม่มีภาพ · ลูกค้าจะเห็นพื้นภาพแบรนด์แทน</p>}
    {value.map((item, index) => <div className="ad-media-row" key={index}>
      {isSafeMediaUrl(item.url) && <MediaPreview key={item.url} src={item.url} alt={item.alt} />}
      <label className="ad-field">URL ภาพที่ {index + 1}<input required type="text" inputMode="url" maxLength={2048} placeholder="https://…" disabled={disabled || pending} value={item.url} ref={(input) => input?.setCustomValidity(isSafeMediaUrl(item.url) ? '' : 'ใช้ลิงก์ HTTPS หรือเส้นทาง /demo-media/ เท่านั้น')} onChange={(event) => update(index, { url: event.target.value })} /></label>
      <label className="ad-field">คำอธิบายภาพ (alt) ที่ {index + 1}<input value={item.alt ?? ''} disabled={disabled} maxLength={200} placeholder="อธิบายสิ่งที่เห็นในภาพ" onChange={(event) => update(index, { alt: event.target.value })} /></label>
      {item.url.startsWith('/demo-media/') && <p className="ad-muted">ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง</p>}
      <button type="button" className="ad-link" disabled={disabled || pending} aria-label={`ลบภาพที่ ${index + 1}`} onClick={() => change(latest.current.value.filter((_, i) => i !== index))}>ลบภาพ</button>
    </div>)}
    <button type="button" className="ad-secondary" disabled={disabled || pending || value.length >= MAX_MEDIA} onClick={() => { if (!uploader.current?.busy && !disabled && latest.current.value.length < MAX_MEDIA) change([...latest.current.value, { url: '', alt: '' }]); }}>+ เพิ่ม URL ภาพ</button>
    <p className="ad-muted">ภาพจะเปลี่ยนในหน้าลูกค้าหลังจากกดบันทึกด้านล่างเท่านั้น · ลบภาพออกจากรายการไม่ได้ลบไฟล์สาธารณะที่อัปโหลดไปแล้ว</p>
  </fieldset>;
}
