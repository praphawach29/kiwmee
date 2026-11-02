"use client";

import { useState } from "react";

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
  return (
    <span className="bk-media-image" data-state={state}>
      {state !== "error" && <img src={item.url} alt={mediaAlt(item, name)} loading={eager ? "eager" : "lazy"} decoding="async" referrerPolicy="no-referrer" onLoad={() => setState("loaded")} onError={() => setState("error")} />}
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
              <strong>{item.value}</strong>
              <span className="bk-review-edit" aria-hidden="true">เปลี่ยน</span>
            </button>
          </li>
        ))}
      </ul>
      {price && <div className="bk-review-total"><span>{price.label}</span><strong>{price.value}</strong></div>}
    </section>
  );
}

export function BookingSubmitBar({ formId, disabled, busy, price }) {
  return (
    <div className="bk-submit-bar">
      <button type="submit" form={formId} className="bk-primary" disabled={disabled}>
        {busy ? "กำลังยืนยัน…" : price ? `ยืนยันการจอง · ${price}` : "ยืนยันการจอง"}
      </button>
    </div>
  );
}
