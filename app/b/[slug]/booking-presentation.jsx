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
  if (!item) return <section className="bk-gallery-empty" aria-label="ภาพร้าน"><span aria-hidden="true" className="bk-shop-monogram">{shop.name?.[0]}</span><div><strong>{shop.name}</strong><p className="bk-muted">ยังไม่มีภาพจากร้าน · จองผ่าน Kiwmee</p></div></section>;
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
  return <span className="bk-offering-media">{item ? <><MediaImage key={item.url} item={item} name={offering.name} />{isDemo(item) && <span className="bk-media-caption">ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง</span>}</> : <span className="bk-offering-placeholder"><span aria-hidden="true">{offering.name?.[0]}</span><small>ยังไม่มีภาพจากร้าน</small></span>}</span>;
}
export function ShopHeader({ shop, subtitle }) {
  return (
    <header className="bk-header bk-shop-header">
      <span className="bk-shop-monogram" aria-hidden="true">{shop.name?.[0]}</span>
      <div><p className="bk-eyebrow">จองกับร้าน</p><h1>{shop.name}</h1><p className="bk-muted">{subtitle}</p></div>
    </header>
  );
}

export function BookingProgress({ phase }) {
  const phases = [{ key: "selection", label: "เลือกคิว" }, { key: "customer", label: "ข้อมูลผู้จอง" }, { key: "complete", label: "ยืนยัน" }];
  const current = phases.findIndex((item) => item.key === phase);
  return (
    <ol className="bk-progress" aria-label="ภาพรวมการจอง">
      {phases.map((item, index) => <li key={item.key} aria-current={phase === item.key ? "step" : undefined} data-done={index < current}><span aria-hidden="true">{index < current ? "✓" : index + 1}</span>{item.label}</li>)}
    </ol>
  );
}

export function BookingReview({ items, onEdit, busy }) {
  return (
    <section className="bk-card bk-review" aria-labelledby="booking-review-title">
      <div><p className="bk-eyebrow">ก่อนยืนยัน</p><h2 id="booking-review-title">สรุปการจอง</h2><p className="bk-muted">ตรวจสอบวันเวลาและบริการที่เลือก</p></div>
      <dl className="bk-summary">
        {items.map((item) => <div key={item.step}><dt>{item.label}</dt><dd><strong>{item.value}</strong><button type="button" className="bk-text-button" disabled={busy} onClick={() => onEdit(item.step)} aria-label={`เปลี่ยน${item.label}`}>เปลี่ยน</button></dd></div>)}
      </dl>
    </section>
  );
}

export function BookingSubmitBar({ formId, disabled, busy }) {
  return (
    <div className="bk-submit-bar">
      <div className="bk-submit-copy"><strong>พร้อมยืนยันการจอง</strong><span>ตรวจสอบรายละเอียดและข้อมูลติดต่อ</span></div>
      <button type="submit" form={formId} className="bk-primary" disabled={disabled}>
        {busy ? "กำลังยืนยัน…" : "ยืนยันการจอง"}
      </button>
    </div>
  );
}
