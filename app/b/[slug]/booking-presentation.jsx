"use client";

import { useEffect, useRef, useState } from "react";
import { amenityList } from "../../../src/v2/amenities.js";

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

// "นำทาง": the shop's map link, or a Google Maps search for its address (src/v2/directions.js)
export function DirectionsButton({ href, className = "bk-secondary bk-directions" }) {
  if (typeof href !== "string" || !href.startsWith("https://")) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></svg>
      นำทางไปร้าน
    </a>
  );
}

// About the venue and what it offers, as icons (the owner's "Facilities" reference)
export function ShopAbout({ shop }) {
  const [open, setOpen] = useState(false);
  const amenities = amenityList(shop.amenities);
  const about = (shop.about ?? "").trim();
  const address = (shop.address ?? "").trim();
  if (!about && amenities.length === 0 && !address && !shop.directions) return null;
  const long = about.length > 120;
  return (
    <section className="bk-card bk-about" aria-label={`เกี่ยวกับ ${shop.name}`}>
      {about && (
        <div className="bk-about-text">
          <p data-open={open || !long || undefined}>{about}</p>
          {long && <button type="button" className="bk-text-button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "ย่อ" : "อ่านต่อ"}</button>}
        </div>
      )}
      {(address || shop.directions) && (
        <div className="bk-place">
          {address && <p><span aria-hidden="true">📍</span>{address}</p>}
          <DirectionsButton href={shop.directions} />
        </div>
      )}
      {amenities.length > 0 && (
        <div className="bk-amenities-wrap">
          <h2>สิ่งอำนวยความสะดวก</h2>
          <ul className="bk-amenities">
            {amenities.map((a) => (
              <li key={a.code}><span aria-hidden="true">{a.icon}</span>{a.label}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// An app's bottom bar: book, or see my bookings (/b/<slug>/me). Shown where LINE login is set up.
export function CustomerTabs({ slug, active }) {
  const tabs = [
    { key: "services", href: `/b/${slug}/services`, label: "บริการ & ราคา", icon: <><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></> },
    { key: "book", href: `/b/${slug}`, label: "จองคิว", icon: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17M12 13v5M9.5 15.5h5" /></> },
    { key: "me", href: `/b/${slug}/me`, label: "การจองของฉัน", icon: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4" /></> }
  ];
  return (
    <nav className="bk-tabs" aria-label="เมนู">
      {tabs.map((t) => (
        <a key={t.key} href={t.href} aria-current={active === t.key ? "page" : undefined}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{t.icon}</svg>
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
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

// steps: 1–3, the three steps shown at the header's right on wide screens (design BookDesktop)
const HEADER_STEPS = ["บริการ", "วันและเวลา", "ข้อมูลผู้จอง"];
export function ShopHeader({ shop, subtitle, steps = null }) {
  return (
    <header className="bk-header bk-shop-header">
      <span className="bk-shop-monogram" aria-hidden="true">{shop.name?.[0]}</span>
      <div className="bk-shop-header-info">
        <h1>{shop.name}</h1>
        {shop.today !== undefined ? (
          // one line (design "Kiwmee ปรับหน้าตา"): open today or not, then where
          <p className="bk-shop-line">
            <span className="bk-shop-today" data-open={shop.today?.state === "open"}>
              {!shop.today
                ? `วันนี้ร้านปิด${shop.address ? "" : " · จองล่วงหน้าได้"}`
                : shop.today.state === "open"
                  ? `เปิดอยู่ · ถึง ${shop.today.close} น.`
                  : shop.today.state === "closed"
                    ? `วันนี้ปิดแล้ว${shop.address ? "" : " · จองล่วงหน้าได้"}`
                    : `เปิดวันนี้ ${shop.today.open}–${shop.today.close} น.`}
            </span>
            {shop.address && <span className="bk-shop-place"> · {shop.address}</span>}
          </p>
        ) : (
          <p className="bk-muted">
            {shop.address ? (
              <span className="bk-header-location">
                <span className="bk-pin-icon" aria-hidden="true">📍</span> {shop.address}
              </span>
            ) : (
              subtitle
            )}
          </p>
        )}
      </div>
      {steps && (
        <ol className="bk-header-steps" aria-label="ขั้นตอนการจอง">
          {HEADER_STEPS.map((label, i) => (
            <li key={label} data-state={i + 1 < steps ? "done" : i + 1 === steps ? "now" : "later"} aria-current={i + 1 === steps ? "step" : undefined}>
              {i + 1 < steps ? "✓" : i + 1} {label}
            </li>
          ))}
        </ol>
      )}
    </header>
  );
}

const PHASES = [
  { key: "selection", label: "เลือกคิว" },
  { key: "availability", label: "วันและเวลา" },
  { key: "customer", label: "ข้อมูลผู้จอง" },
  { key: "complete", label: "ยืนยัน" }
];

export function BookingProgress({ phase, ask, resourceWord = "รายการ" }) {
  let stepIndex = 0;
  const totalSteps = 4;
  let stepTitle = "เลือกบริการ";

  if (phase === "complete") {
    stepIndex = 3;
    stepTitle = "จองสำเร็จ & ตั๋วคิว";
  } else if (phase === "customer") {
    stepIndex = 2;
    stepTitle = "ข้อมูลผู้จอง & สรุปนัด";
  } else if (ask === "offering" || !ask) {
    stepIndex = 0;
    stepTitle = "เลือกบริการ";
  } else {
    stepIndex = 1;
    stepTitle = ask === "resource" ? `เลือก${resourceWord}` : ask === "date" ? "เลือกวัน" : ask === "time" ? "วันและเวลา" : ask === "duration" ? "เลือกระยะเวลา" : ask === "addons" ? "เลือกตัวเลือกเสริม" : "เลือกคิว";
  }

  const percent = Math.round(((stepIndex + 1) / totalSteps) * 100);
  const current = phase === "complete" ? 3 : phase === "customer" ? 2 : stepIndex === 0 ? 0 : 1;
  // what comes after this screen: the day and time still to pick come before the form
  const nextText = phase === "selection" && ["resource", "duration", "party"].includes(ask)
    ? "ต่อไป: วันและเวลา"
    : phase === "selection" && ask === "date"
      ? "ต่อไป: เลือกเวลา"
      : PHASES[current + 1] ? `ต่อไป: ${PHASES[current + 1].label}` : "เสร็จแล้ว";
  return (
    <div className="bk-progress-wrap">
      <div className="bk-progress-meta">
        <span className="bk-step-badge"><b>ขั้นที่ {stepIndex + 1}</b> จาก {totalSteps} · {stepTitle}</span>
        <span className="bk-progress-pct">{nextText}</span>
      </div>
      <ol className="bk-progress" aria-label="ภาพรวมการจอง">
        {PHASES.map((item, index) => (
          <li key={item.key} aria-current={index === current ? "step" : undefined} data-done={index < current}>
            <span aria-hidden="true">{index < current ? "✓" : index + 1}</span>
            {item.label}
          </li>
        ))}
      </ol>
      <div className="bk-progress-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
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

const STEP_ICON = {
  offering: "✂️",
  resource: "👤",
  date: "📅",
  time: "⏰",
  duration: "⏱️",
  party: "👥",
  addons: "➕"
};

export function BookingReview({ items, onEdit, busy, price, id = "booking-review-title" }) {
  return (
    <section className="bk-card bk-review" aria-labelledby={id}>
      <div className="bk-review-head">
        <span className="bk-review-icon-pill" aria-hidden="true">📋</span>
        <h2 id={id}>สรุปการจอง</h2>
      </div>
      <ul className="bk-review-list">
        {items.map((item) => (
          <li key={item.step}>
            <button type="button" className="bk-review-row" disabled={busy} onClick={() => onEdit(item.step)} aria-label={`เปลี่ยน${item.label}: ${item.value}`}>
              <span className="bk-review-step-icon" aria-hidden="true">{STEP_ICON[item.step] || "•"}</span>
              <span className="bk-review-label">{item.label}</span>
              <strong>{item.display ?? item.value}</strong>
              <span className="bk-review-edit" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {price && (
        <div className="bk-review-total">
          <div className="bk-review-total-main">
            <span>{price.label}</span>
            <strong>{price.value}</strong>
          </div>
        </div>
      )}
    </section>
  );
}

// Stacked confirmation drawer matching Stitch Screen 3: status badge + price on top, full-width button below
export function BookingSubmitBar({ formId, disabled, busy, price, deposit, payFull = false, label = "ราคารวม" }) {
  const isDeposit = typeof deposit === "number" && deposit > 0;
  // two columns, each a label over its amount: the whole price, and what is paid now (or at the shop)
  return (
    <div className="bk-submit-bar" data-has-price={Boolean(price) || undefined}>
      {price && (
        <div className="bk-submit-total" aria-hidden="true">
          <div className="bk-submit-sum">
            <small>{label}</small>
            <strong>{price}</strong>
          </div>
          <div className="bk-submit-now" data-now={isDeposit || undefined}>
            <small>{isDeposit ? (payFull ? "จ่ายเต็มตอนนี้" : "มัดจำตอนนี้") : "ชำระเงิน"}</small>
            <strong>{isDeposit ? `${deposit.toLocaleString("th-TH")} บาท` : "ที่ร้าน"}</strong>
          </div>
        </div>
      )}
      <button
        type="submit"
        form={formId}
        className="bk-primary bk-btn-full"
        disabled={disabled}
        aria-label={busy ? undefined : price ? `ยืนยันการจอง · ${price}` : undefined}
      >
        {busy ? (
          "กำลังยืนยัน…"
        ) : (
          <span className="bk-btn-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{isDeposit ? (payFull ? "ยืนยันและดู QR ชำระเงิน" : "ยืนยันและดู QR มัดจำ") : "ยืนยันการจองคิว"}</span>
          </span>
        )}
      </button>
      <p className="bk-submit-fine" aria-hidden="true">
        เมื่อกดยืนยัน ถือว่าท่านยอมรับ <a href="/terms" target="_blank" rel="noreferrer">เงื่อนไขการให้บริการ</a> ของ Kiwmee
      </p>
    </div>
  );
}

// ---------- rental documents (migration …002700, design 11.7 E3) ----------

/**
 * The ID / licence a rental asks for. Nothing is sent before the customer ticks the consent, which says
 * who keeps it, why, and when it is deleted. uploadUrl: /api/b/<slug>/manage/<token>/document
 * onUploaded(view) gets the manage page's new data (with view.documents).
 */
export function DocumentsBox({ documents, shopName, uploadUrl, onUploaded }) {
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState({ busy: null, error: "" });
  if (!documents?.required?.length) return null;
  const sent = new Set((documents.uploaded ?? []).map((d) => d.kind));
  const done = documents.required.every((d) => sent.has(d.kind));
  const labels = documents.required.map((d) => d.label).join(" และ ");

  async function upload(kind, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return setState({ busy: null, error: "เลือกรูปเป็น JPG หรือ PNG" });
    if (file.size > 10 * 1024 * 1024) return setState({ busy: null, error: "รูปใหญ่เกิน 10 MB" });
    setState({ busy: kind, error: "" });
    try {
      const response = await fetch(`${uploadUrl}?kind=${kind}&consent=yes`, { method: "POST", headers: { "content-type": file.type }, body: file });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "ส่งเอกสารไม่สำเร็จ กรุณาลองใหม่");
      setState({ busy: null, error: "" });
      onUploaded?.(payload.data);
    } catch (e) {
      setState({ busy: null, error: e.message });
    }
  }

  return (
    <section className="bk-docs" data-done={done || undefined} aria-labelledby="docs-title">
      <div className="bk-deposit-head">
        <h2 id="docs-title">เอกสารประกอบการเช่า</h2>
        <span className="bk-status" data-status={done ? "confirmed" : "held"}>{done ? "ส่งครบแล้ว" : `ส่งแล้ว ${sent.size}/${documents.required.length}`}</span>
      </div>
      <p className="bk-muted">ร้านขอรูป{labels}ของผู้เช่า เพื่อยืนยันตัวตนก่อนรับของ</p>
      <label className="bk-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          ยินยอมให้ <b>{shopName}</b> เก็บรูป{labels}ของฉัน เพื่อยืนยันตัวตนสำหรับการเช่านี้เท่านั้น · เห็นได้เฉพาะร้าน · เข้ารหัสเก็บไว้ และ
          <b> ลบอัตโนมัติ {documents.retentionDays} วันหลังคืนของ</b> หรือทันทีเมื่อยกเลิกการจอง
        </span>
      </label>
      <ul className="bk-doc-list">
        {documents.required.map((d) => (
          <li key={d.kind}>
            <span className="bk-doc-name">
              <span aria-hidden="true">{sent.has(d.kind) ? "✅" : "🪪"}</span>
              {d.label}
              {sent.has(d.kind) && <small> · ส่งแล้ว</small>}
            </span>
            <label className={sent.has(d.kind) ? "bk-secondary bk-upload" : "bk-primary bk-upload"} aria-disabled={!consent || state.busy !== null}>
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={!consent || state.busy !== null} onChange={(e) => upload(d.kind, e)} />
              {state.busy === d.kind ? "กำลังส่ง…" : sent.has(d.kind) ? "ส่งใหม่" : "ถ่าย/แนบรูป"}
            </label>
          </li>
        ))}
      </ul>
      {!consent && !done && <p className="bk-fine">ติ๊กยินยอมก่อน แล้วจึงแนบรูปได้</p>}
      {state.error && <p className="bk-error" role="alert">{state.error}</p>}
    </section>
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
const SLIP_REASON = {
  AMOUNT_LOW: "ยอดในสลิปน้อยกว่ามัดจำ",
  RECEIVER_MISMATCH: "บัญชีผู้รับไม่ตรงกับบัญชีร้าน",
  RECEIVER_UNKNOWN: "ตรวจบัญชีผู้รับไม่ได้",
  TOO_EARLY: "เวลาโอนก่อนจองคิวนี้",
  DUPLICATE: "สลิปนี้เคยใช้แล้ว",
  UNREADABLE: "อ่านสลิปไม่ชัด"
};

export function DepositBox({ deposit, status, deadline, uploadUrl, onUploaded }) {
  const [state, setState] = useState({ busy: false, error: "" });
  const [check, setCheck] = useState(null); // the automatic slip check, when the platform runs one
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
      setCheck(payload.data?.slipCheck ?? null);
      onUploaded?.(payload.data);
    } catch (e) {
      setState({ busy: false, error: e.message });
    }
  }

  return (
    <section className="bk-deposit" data-status={status} aria-labelledby="deposit-title">
      <div className="bk-deposit-head">
        <h2 id="deposit-title">{waiting ? (deposit.payFull ? "โอนชำระเต็มจำนวนเพื่อยืนยันคิว" : "โอนมัดจำเพื่อยืนยันคิว") : "ส่งสลิปแล้ว รอร้านตรวจ"}</h2>
        <strong className="bk-deposit-amount">{baht(deposit.due)}</strong>
      </div>
      {waiting && deadline && <p className="bk-deposit-deadline">กรุณาโอนและส่งสลิปภายใน <b>{deadline}</b> ไม่อย่างนั้นคิวจะถูกปล่อยให้คนอื่น</p>}
      {!waiting && <p className="bk-muted">ร้านจะยืนยันคิวเมื่อตรวจยอดแล้ว · ส่งสลิปเพิ่มได้ถ้าโอนหลายครั้ง</p>}
      {waiting && typeof deposit.qr === "string" && deposit.qr.startsWith("data:image/png;base64,") && (
        <figure className="bk-qr">
          <span className="bk-qr-brand" aria-hidden="true">PromptPay · พร้อมเพย์</span>
          <img src={deposit.qr} alt={`QR พร้อมเพย์ ยอด ${baht(deposit.due)}`} width="220" height="220" />
          <figcaption>
            <strong>สแกนจ่ายด้วยแอปธนาคาร</strong>
            <span>ยอด {baht(deposit.due)} ใส่ให้แล้ว{info.accountName ? ` · ${info.accountName}` : ""}</span>
          </figcaption>
          <a className="bk-secondary" href={deposit.qr} download="promptpay-qr.png">บันทึกรูป QR</a>
          <small className="bk-muted">ในแอป LINE: กดค้างที่รูปเพื่อบันทึก แล้วเลือกจากอัลบั้มในแอปธนาคาร</small>
        </figure>
      )}
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
      {check && (
        <p className={check.status === "passed" ? "bk-notice bk-slip-ok" : "bk-notice"} role="status" data-testid="slip-check">
          {check.confirmed
            ? "✓ ตรวจสลิปแล้ว ยอดครบ ยืนยันคิวให้เรียบร้อย"
            : check.status === "passed"
              ? "✓ สลิปผ่านการตรวจเบื้องต้น รอร้านยืนยัน"
              : check.status === "failed"
                ? `ระบบตรวจพบ: ${check.reasons.map((r) => SLIP_REASON[r] ?? r).join(" · ")} — ร้านจะตรวจอีกครั้ง หรือส่งสลิปที่ถูกต้องเพิ่มได้`
                : "ส่งสลิปแล้ว ร้านจะตรวจและยืนยันให้"}
        </p>
      )}
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
