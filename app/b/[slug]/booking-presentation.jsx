"use client";

import { useEffect, useRef, useState } from "react";

// Presentation only: the booking engine remains the source of selections and next steps.
const isDemo = (item) => item?.url?.startsWith("/demo-media/");
const safeMedia = (media) => (Array.isArray(media) ? media : []).filter((item) => {
  if (typeof item?.url !== "string") return false;
  if (/^\/demo-media\/[a-zA-Z0-9_./-]+$/.test(item.url) && !item.url.includes("..")) return true;
  try { const url = new URL(item.url); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}).slice(0, 8);
const mediaAlt = (item, name) => `${isDemo(item) ? "ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง · " : ""}${item.alt || name || "ภาพจากร้าน"}`;

// "ช่างแนน" → "แน": skip the word for the kind, keep a leading vowel with its consonant
export function initial(name) {
  const bare = String(name || "").replace(/^(ช่าง|คุณ|สนาม|ห้อง)\s*/, "").trim() || String(name || "").trim();
  if (!bare) return "◇";
  return /^[เแโใไ]/.test(bare) ? bare.slice(0, 2) : bare[0];
}

export function MediaImage({ item, name, eager = false }) {
  const [state, setState] = useState("loading");
  const img = useRef(null);
  // a picture sent with the page can finish loading before React listens for onLoad: check once
  useEffect(() => {
    const el = img.current;
    if (el?.complete) setState(el.naturalWidth > 0 ? "loaded" : "error");
  }, []);
  return (
    <span className="bk-media-image" data-state={state}>
      {state !== "error" && <img ref={img} src={item.url} alt={mediaAlt(item, name)} loading={eager ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer" onLoad={() => setState("loaded")} onError={() => setState("error")} />}
      {state !== "loaded" && <span className="bk-media-status" role="status">{state === "error" ? "โหลดภาพไม่สำเร็จ" : "กำลังโหลดภาพ…"}</span>}
    </span>
  );
}

export function ShopGallery({ shop }) {
  const media = safeMedia(shop.media);
  const [selected, setSelected] = useState(0);
  const item = media[selected] || media[0];
  // no photos yet: the shop header already carries the name, so show nothing rather than a placeholder
  if (!item) return null;
  return (
    <section className="bk-gallery" aria-label="แกลเลอรีภาพร้าน">
      <figure className="bk-gallery-cover">
        <MediaImage key={item.url} item={item} name={shop.name} eager />
        <figcaption aria-live="polite">{isDemo(item) ? "ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง" : item.alt || `ภาพจาก ${shop.name}`}</figcaption>
      </figure>
      {media.length > 1 && <div className="bk-gallery-thumbnails" aria-label="เลือกภาพร้าน">{media.map((image, index) => <button key={`${image.url}-${index}`} type="button" aria-label={`ดูภาพที่ ${index + 1}: ${mediaAlt(image, shop.name)}`} aria-pressed={item === image} onClick={() => setSelected(index)}><MediaImage key={image.url} item={image} name={shop.name} /></button>)}</div>}
    </section>
  );
}

// The shop's photos as the top of the page (an app-like cover): one big picture across the screen,
// the others as small thumbnails on it. compact = a lower strip while the customer fills in details.
export function ShopHero({ shop, compact = false }) {
  const media = safeMedia(shop.media);
  const [selected, setSelected] = useState(0);
  const item = media[selected] || media[0];
  if (!item) return null;
  return (
    <section className="bk-hero" data-compact={compact || undefined} aria-label="แกลเลอรีภาพร้าน">
      <MediaImage key={item.url} item={item} name={shop.name} eager />
      {isDemo(item) && <span className="bk-hero-tag">ภาพประกอบ ไม่ใช่สถานที่จริง</span>}
      {!compact && media.length > 1 && (
        <div className="bk-hero-thumbs" aria-label="เลือกภาพร้าน">
          {media.map((image, index) => (
            <button key={`${image.url}-${index}`} type="button" aria-label={`ดูภาพที่ ${index + 1}: ${mediaAlt(image, shop.name)}`} aria-pressed={item === image} onClick={() => setSelected(index)}>
              <MediaImage key={image.url} item={image} name={shop.name} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export const withMedia = (thing) => safeMedia(thing?.media).length > 0;

export function OfferingThumbnail({ offering }) {
  const item = safeMedia(offering.media)[0];
  if (!item) return null;
  return <span className="bk-offering-media"><MediaImage key={item.url} item={item} name={offering.name} />{isDemo(item) && <span className="bk-media-caption">ภาพประกอบ</span>}</span>;
}
export function ResourceThumbnail({ resource }) {
  const item = safeMedia(resource?.media)[0];
  if (!item) return <span className="bk-avatar" aria-hidden="true">{initial(resource?.name)}</span>;
  return <span className="bk-resource-media">{<MediaImage key={item.url} item={item} name={resource.name} />}{isDemo(item) && <span className="bk-media-caption">ภาพประกอบ</span>}</span>;
}

export function ResourceChoice({ resource, label, resourceWord = "ช่าง", any = false }) {
  if (any) return <><span className="bk-avatar bk-avatar-any" aria-hidden="true">✱</span><span className="bk-option-text"><strong>{resourceWord}{resourceWord === "ช่าง" ? "คนไหนก็ได้" : "ใดก็ได้"}</strong><small className="bk-muted">ระบบเลือกที่ว่างให้</small></span><span className="bk-choice-mark" aria-hidden="true" /></>;
  return <><ResourceThumbnail resource={resource} /><span className="bk-option-text"><strong>{resource?.name || label}</strong></span><span className="bk-choice-mark" aria-hidden="true" /></>;
}

export function ResourceSummary({ resources }) {
  return <span className="bk-manage-resources">{resources.map((resource) => <span className="bk-manage-resource" key={resource.id || resource.name}>{safeMedia(resource.media).length > 0 && <ResourceThumbnail resource={resource} />}<span>{resource.name}</span></span>)}</span>;
}

export function ShopHeader({ shop, subtitle }) {
  return (
    <header className="bk-header bk-shop-header">
      <span className="bk-shop-monogram" aria-hidden="true">{shop.name?.[0]}</span>
      <div><h1>{shop.name}</h1><p className="bk-muted">{subtitle}</p></div>
    </header>
  );
}

const PHASES = [{ key: "selection", label: "เลือกคิว" }, { key: "customer", label: "ข้อมูลผู้จอง" }, { key: "complete", label: "ยืนยัน" }];

export function BookingProgress({ phase }) {
  const current = PHASES.findIndex((item) => item.key === phase);
  return (
    <div className="bk-progress-wrap">
      <ol className="bk-progress" aria-label="ภาพรวมการจอง">
        {PHASES.map((item, index) => <li key={item.key} aria-current={phase === item.key ? "step" : undefined} data-done={index < current}><span aria-hidden="true">{index < current ? "✓" : index + 1}</span>{item.label}</li>)}
      </ol>
      <div className="bk-progress-bar" aria-hidden="true"><span style={{ width: `${((current + 1) / PHASES.length) * 100}%` }} /></div>
    </div>
  );
}

// Times the server offers, grouped the way people think about a day.
export function groupTimes(options) {
  const parts = [
    { key: "morning", label: "ช่วงเช้า", options: [] },
    { key: "afternoon", label: "ช่วงบ่าย", options: [] },
    { key: "evening", label: "ช่วงเย็น", options: [] }
  ];
  for (const option of options) {
    const hour = Number(String(option.value).slice(0, 2));
    parts[hour < 12 ? 0 : hour < 17 ? 1 : 2].options.push(option);
  }
  return parts.filter((part) => part.options.length > 0);
}

export function BookingReview({ items, onEdit, busy, price, id = "booking-review-title" }) {
  return (
    <section className="bk-card bk-review" aria-labelledby={id}>
      <h2 id={id}>สรุปการจอง</h2>
      <ul className="bk-review-list">
        {items.map((item) => (
          <li key={item.step}>
            <button type="button" className="bk-review-row" disabled={busy} onClick={() => onEdit(item.step)} aria-label={`เปลี่ยน${item.label}: ${item.value}`}>
              <span className="bk-review-label">{item.label}</span>
              <strong>{item.display ?? item.value}</strong>
              <span className="bk-review-edit" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {price && <div className="bk-review-total"><span>{price.label}</span><strong>{price.value}</strong></div>}
    </section>
  );
}

// The total on the left, the button on the right (like an app's checkout bar)
export function BookingSubmitBar({ formId, disabled, busy, price, label = "ราคารวม" }) {
  return (
    <div className="bk-submit-bar" data-has-price={Boolean(price) || undefined}>
      {price && (
        <div className="bk-submit-total" aria-hidden="true">
          <small>{label}</small>
          <strong>{price}</strong>
        </div>
      )}
      <button type="submit" form={formId} className="bk-primary" disabled={disabled} aria-label={busy ? undefined : price ? `ยืนยันการจอง · ${price}` : undefined}>
        {busy ? "กำลังยืนยัน…" : "ยืนยันการจอง"}
      </button>
    </div>
  );
}

// ---------- transfer deposit (migration …002200) ----------

const baht = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;

function CopyValue({ label, value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value.replace(/[\s-]/g, ""));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="bk-copy-row">
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        <button type="button" className="bk-text-button" onClick={copy} aria-label={`คัดลอก${label}`}>{copied ? "คัดลอกแล้ว" : "คัดลอก"}</button>
      </dd>
    </div>
  );
}

/**
 * How much to transfer, where, and by when; then the slip. `status` is the booking's: held = still to
 * pay, pending = slip sent (the shop is checking). onUploaded(view) gets the manage page's new data.
 * uploadUrl: /api/b/<slug>/manage/<token>/slip — the customer's own link is their only key.
 */
export function DepositBox({ deposit, status, deadline, uploadUrl, onUploaded }) {
  const [state, setState] = useState({ busy: false, error: "" });
  const info = deposit.paymentInfo ?? {};
  const waiting = status === "held";

  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setState({ busy: false, error: "เลือกรูปสลิปเป็น JPG หรือ PNG" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setState({ busy: false, error: "รูปใหญ่เกิน 5 MB" });
      return;
    }
    setState({ busy: true, error: "" });
    try {
      const response = await fetch(uploadUrl, { method: "POST", headers: { "content-type": file.type }, body: file });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "ส่งสลิปไม่สำเร็จ กรุณาลองใหม่");
      setState({ busy: false, error: "" });
      onUploaded?.(payload.data);
    } catch (e) {
      setState({ busy: false, error: e.message });
    }
  }

  return (
    <section className="bk-deposit" data-status={status} aria-labelledby="deposit-title">
      <div className="bk-deposit-head">
        <h2 id="deposit-title">{waiting ? "โอนมัดจำเพื่อยืนยันคิว" : "ส่งสลิปแล้ว รอร้านตรวจ"}</h2>
        <strong className="bk-deposit-amount">{baht(deposit.due)}</strong>
      </div>
      {waiting && deadline && <p className="bk-deposit-deadline">กรุณาโอนและส่งสลิปภายใน <b>{deadline}</b> ไม่อย่างนั้นคิวจะถูกปล่อยให้คนอื่น</p>}
      {!waiting && <p className="bk-muted">ร้านจะยืนยันคิวเมื่อตรวจยอดแล้ว · ส่งสลิปเพิ่มได้ถ้าโอนหลายครั้ง</p>}
      {(info.accountNumber || info.promptPay) && (
        <dl className="bk-bank">
          {info.bank && <div className="bk-copy-row"><dt>ธนาคาร</dt><dd><strong>{info.bank}</strong></dd></div>}
          {info.accountNumber && <CopyValue label="เลขบัญชี" value={info.accountNumber} />}
          {info.promptPay && <CopyValue label="พร้อมเพย์" value={info.promptPay} />}
          {info.accountName && <div className="bk-copy-row"><dt>ชื่อบัญชี</dt><dd><strong>{info.accountName}</strong></dd></div>}
        </dl>
      )}
      {info.note && <p className="bk-muted">{info.note}</p>}
      <label className={waiting ? "bk-primary bk-upload" : "bk-secondary bk-upload"} aria-disabled={state.busy}>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={state.busy} />
        {state.busy ? "กำลังส่งสลิป…" : waiting ? "แนบสลิปการโอน" : "ส่งสลิปเพิ่ม"}
      </label>
      {state.error && <p className="bk-error" role="alert">{state.error}</p>}
      {deposit.slips > 0 && <p className="bk-muted">ส่งสลิปแล้ว {deposit.slips} รูป</p>}
    </section>
  );
}

// ---------- one service, in full (opened from "รายละเอียด" on its card) ----------

/** A sheet over the page: the service's photos, length, price and description, and a button to pick it */
export function OfferingDetails({ offering, length, price, available, reason, busy, onChoose, onClose }) {
  useEffect(() => {
    const close = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const hasMedia = safeMedia(offering.media).length > 0;
  return (
    <>
      <button type="button" className="bk-sheet-backdrop" aria-label="ปิด" onClick={onClose} />
      <section className="bk-sheet" role="dialog" aria-modal="true" aria-labelledby="offering-details-title">
        <div className="bk-sheet-grip" aria-hidden="true" />
        {hasMedia && <ShopGallery shop={{ name: offering.name, media: offering.media }} />}
        <div className="bk-sheet-head">
          <h2 id="offering-details-title">{offering.name}</h2>
          <button type="button" className="bk-icon-button" aria-label="ปิด" onClick={onClose}>✕</button>
        </div>
        <p className="bk-option-meta">
          <span>{length}</span>
          {price && <b className="bk-option-price">{price}</b>}
        </p>
        {offering.description && <p className="bk-sheet-text">{offering.description}</p>}
        {!available && reason && <p className="bk-notice">{reason}</p>}
        <button type="button" className="bk-primary" disabled={busy || !available} onClick={onChoose}>
          {available ? "เลือกบริการนี้" : "ตอนนี้จองไม่ได้"}
        </button>
      </section>
    </>
  );
}
