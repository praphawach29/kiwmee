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
  const addFiles = (files) => {
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
  const selectFiles = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    addFiles(files);
  };
  // drop photos anywhere on the box
  const [dragging, setDragging] = useState(false);
  const canAdd = !disabled && !pending && value.length < MAX_MEDIA && !!slug;
  const onDragOver = (event) => {
    if (!canAdd || !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event) => {
    if (!canAdd) return;
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer?.files || []));
  };
  const move = (index, to) => {
    const list = [...latest.current.value];
    const [item] = list.splice(index, 1);
    list.splice(to, 0, item);
    change(list);
  };
  const update = (index, patch) => change(latest.current.value.map((item, i) => i === index ? { ...item, ...patch } : item));

  return <fieldset className="ad-media-editor" ref={root} data-dragging={dragging} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
    <legend>{label} ({value.length}/{MAX_MEDIA})</legend>
    <p id={`${id}-help`} className="ad-muted">เลือกจากเครื่องได้ทีละหลายรูป (JPEG, PNG, WebP ไม่เกินรูปละ 5 MB) หรือลากรูปมาวางที่กรอบนี้ · สูงสุด {MAX_MEDIA} รูป · รูปแรกเป็นภาพหลัก</p>
    <div className="ad-media-grid">
      {value.map((item, index) => {
        const safe = isSafeMediaUrl(item.url);
        return <div className="ad-media-row" key={index} data-main={index === 0}>
          <div className="ad-media-thumb">
            {safe ? <MediaPreview key={item.url} src={item.url} alt={item.alt} /> : <span className="ad-muted">{item.url ? 'ลิงก์ภาพไม่ถูกต้อง' : 'วางลิงก์ภาพด้านล่าง'}</span>}
            {index === 0 && <span className="ad-media-badge">ภาพหลัก</span>}
          </div>
          {item.url.startsWith('/demo-media/') && <p className="ad-muted ad-media-demo">ภาพประกอบ ไม่ใช่สถานที่จริง</p>}
          <details className="ad-media-url" ref={(el) => { if (el && !el.dataset.ready) { el.dataset.ready = "1"; if (!safe) el.open = true; } }}>
            <summary>ลิงก์ภาพ</summary>
            <label className="ad-field">URL ภาพที่ {index + 1}<input required type="text" inputMode="url" maxLength={2048} placeholder="https://…" disabled={disabled || pending} value={item.url} ref={(input) => input?.setCustomValidity(isSafeMediaUrl(item.url) ? '' : 'ใช้ลิงก์ HTTPS หรือเส้นทาง /demo-media/ เท่านั้น')} onChange={(event) => update(index, { url: event.target.value })} /></label>
          </details>
          <label className="ad-field ad-media-alt">คำอธิบายภาพ (ไม่บังคับ)<input value={item.alt ?? ''} disabled={disabled} maxLength={200} placeholder="เช่น หน้าร้าน, สนาม 1" onChange={(event) => update(index, { alt: event.target.value })} /></label>
          <div className="ad-media-actions">
            {index > 0 && <button type="button" className="ad-link" disabled={disabled || pending} onClick={() => move(index, 0)}>ตั้งเป็นภาพหลัก</button>}
            <button type="button" className="ad-link ad-media-remove" disabled={disabled || pending} aria-label={`ลบภาพที่ ${index + 1}`} onClick={() => change(latest.current.value.filter((_, i) => i !== index))}>ลบภาพ</button>
          </div>
        </div>;
      })}
      {value.length < MAX_MEDIA && <label className="ad-media-add" htmlFor={`${id}-files`} data-disabled={!canAdd}>
        <span className="ad-media-add-icon" aria-hidden="true">＋</span>
        <strong>{pending ? 'กำลังอัปโหลด…' : 'เพิ่มรูปจากเครื่อง'}</strong>
        <small>แตะเพื่อเลือกรูป หรือลากมาวาง</small>
      </label>}
    </div>
    <input id={`${id}-files`} className="ad-media-file" type="file" multiple accept={MEDIA_ACCEPT} disabled={disabled || pending || value.length >= MAX_MEDIA || !slug} aria-label="เลือกภาพจากเครื่อง" aria-describedby={`${id}-help ${id}-public`} onChange={selectFiles} />
    <input ref={validity} className="ad-media-validity" type="text" value="" onChange={() => {}} tabIndex={-1} aria-label="สถานะการอัปโหลดภาพ" />
    <div role="status" aria-live="polite" className="ad-media-status">{pending ? 'กำลังอัปโหลดภาพ กรุณารอจนเสร็จก่อนบันทึก' : rows.some((row) => row.status === 'success') ? 'อัปโหลดเสร็จแล้ว · กดบันทึกเพื่อให้ลูกค้าเห็น' : ''}</div>
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
    {value.length === 0 && rows.length === 0 && <p className="ad-muted">ยังไม่มีภาพ · ลูกค้าจะเห็นพื้นภาพแบรนด์แทน</p>}
    <div className="ad-media-foot">
      <span className="ad-muted">มีรูปอยู่บนเว็บแล้ว? ใช้ลิงก์ HTTPS ได้</span>
      <button type="button" className="ad-link" disabled={disabled || pending || value.length >= MAX_MEDIA} onClick={() => { if (!uploader.current?.busy && !disabled && latest.current.value.length < MAX_MEDIA) change([...latest.current.value, { url: '', alt: '' }]); }}>+ เพิ่ม URL ภาพ</button>
    </div>
    <p id={`${id}-public`} className="ad-media-disclosure">รูปที่อัปโหลดเป็นสาธารณะทันที แม้ยังไม่กดบันทึก · ห้ามอัปโหลดข้อมูลส่วนตัวลูกค้า ภาพสลิป หรือเอกสารอ่อนไหว · รูปจะเปลี่ยนในหน้าลูกค้าหลังกดบันทึกเท่านั้น</p>
  </fieldset>;
}
