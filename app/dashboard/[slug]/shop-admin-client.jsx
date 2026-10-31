"use client";

// /dashboard/<slug>: the owner sets up the shop without code (design step 5) — resources (stylists,
// courts, rooms), offerings with their prices, opening hours and days off, and the booking flow with
// a preview of what customers will see. Staff use daily booking and bill operations only.
// Every save goes to /api/dashboard/shops/<slug>/…, which writes as the signed-in user (RLS).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api.mjs";
import MerchantSidebar from "../merchant-sidebar.jsx";
import { shopNavigation, shopTabs, resolveShopTab } from "../merchant-navigation.mjs";
import { bookingFlowDraft, bookingFlowFromDraft, catalogWarnings, kindWord, previewPaths, resourceWord } from "./flow-preview.mjs";
import { BOOKING_TEMPLATES, previewBookingTemplate } from "../../../src/v2/booking-templates.js";

// Defense in depth for owner-only settings controls; APIs/RLS enforce permissions.
const ReadOnly = createContext(false);
function Locked({ children }) {
  return <fieldset className="ad-fieldset" disabled={useContext(ReadOnly)}>{children}</fieldset>;
}

const DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์"];
const DAY_SHORT = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const SHOP_KINDS = { salon: "ร้านเสริมสวย", barber: "ร้านตัดผมชาย", spa: "สปา / นวด", court: "สนามกีฬา", other: "อื่น ๆ" };
const RESOURCE_KINDS = { staff: "ช่าง / พนักงาน", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
const UNITS = { per_booking: "ต่อครั้ง", per_hour: "ต่อชั่วโมง", per_person: "ต่อคน" };


const money = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;
const minutes = (m) => (m % 60 ? (m > 60 ? `${Math.floor(m / 60)} ชม. ${m % 60} นาที` : `${m} นาที`) : `${m / 60} ชม.`);
const toInt = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const shopPath = (slug, rest = "") => `/api/dashboard/shops/${slug}${rest}`;

function today() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// "YYYY-MM-DDTHH:MM" now, in the shop's time (Bangkok), to tell a past start from a future one
function nowLocal() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 16);
}

/** busy/error/done around one save; `run` returns true when it worked */
function useSave() {
  const [state, setState] = useState({ busy: false, error: "", done: "" });
  const run = useCallback(async (fn, done = "บันทึกแล้ว") => {
    setState({ busy: true, error: "", done: "" });
    try {
      await fn();
      setState({ busy: false, error: "", done });
      return true;
    } catch (e) {
      if (e.status === 401) window.location.href = "/dashboard";
      setState({ busy: false, error: e.message, done: "" });
      return false;
    }
  }, []);
  return { ...state, run };
}

export function MediaEditor({ value = [], onChange, label }) {
  const readOnly = useContext(ReadOnly);
  if (readOnly) return null;
  const update = (index, patch) => onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item));
  return (
    <fieldset className="ad-media-editor">
      <legend>{label} ({value.length}/8)</legend>
      <p className="ad-muted">ใส่ลิงก์ภาพ HTTPS หรือ /demo-media/ ได้สูงสุด 8 ภาพ · ยังไม่มีการอัปโหลดไฟล์ · ภาพแรกเป็นภาพหลัก</p>
      {value.length === 0 && <p className="ad-muted">ยังไม่มีภาพ · ลูกค้าจะเห็นพื้นภาพแบรนด์แทน</p>}
      {value.map((item, index) => <div className="ad-media-row" key={index}>
        <label className="ad-field">URL ภาพที่ {index + 1}<input required type="text" inputMode="url" maxLength={2048} placeholder="https://…" value={item.url} onChange={(event) => { event.target.setCustomValidity(""); update(index, { url: event.target.value }); }} onBlur={(event) => {
          const url = event.target.value;
          let valid = /^\/demo-media\/[a-zA-Z0-9_./-]+$/.test(url) && !url.includes("..");
          try { const parsed = new URL(url); valid = valid || (parsed.protocol === "https:" && !parsed.username && !parsed.password); } catch { /* local demo paths checked above */ }
          event.target.setCustomValidity(valid ? "" : "ใช้ลิงก์ HTTPS หรือเส้นทาง /demo-media/ เท่านั้น");
        }} /></label>
        <label className="ad-field">คำอธิบายภาพ (alt) ที่ {index + 1}<input value={item.alt ?? ""} maxLength={200} placeholder="อธิบายสิ่งที่เห็นในภาพ" onChange={(event) => update(index, { alt: event.target.value })} /></label>
        {item.url.startsWith("/demo-media/") && <p className="ad-muted">ILLUSTRATION · ภาพประกอบ ไม่ใช่ภาพสถานที่จริง</p>}
        <button type="button" className="ad-link" aria-label={`ลบภาพที่ ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>ลบภาพ</button>
      </div>)}
      <button type="button" className="ad-secondary" disabled={value.length >= 8} onClick={() => onChange([...value, { url: "", alt: "" }])}>+ เพิ่ม URL ภาพ</button>
      <p className="ad-muted">ภาพจะเปลี่ยนในหน้าลูกค้าหลังจากกดบันทึกด้านล่างเท่านั้น</p>
    </fieldset>
  );
}

function Status({ save }) {
  if (save.error) return <p className="ad-error" role="alert">{save.error}</p>;
  if (save.done) return <p className="ad-ok" role="status">{save.done}</p>;
  return null;
}

export default function ShopAdmin({ slug }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  const [requestedTab, setRequestedTab] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    try {
      setCatalog(await api("GET", shopPath(slug)));
      setVersion((v) => v + 1);
    } catch (e) {
      if (e.status === 401) window.location.href = "/dashboard";
      setError(e.message);
    }
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const syncHash = () => setRequestedTab(window.location.hash.slice(1));
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const role = catalog?.shop.role;
  const tab = resolveShopTab(role, requestedTab);
  useEffect(() => {
    if (catalog && tab && requestedTab !== tab) {
      window.history.replaceState(null, "", `#${tab}`);
      setRequestedTab(tab);
    }
  }, [catalog, tab, requestedTab]);

  function show(key) {
    const allowed = resolveShopTab(role, key);
    if (!allowed) return;
    setRequestedTab(allowed);
    window.history.replaceState(null, "", `#${allowed}`);
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError("");
    try {
      await api("DELETE", "/api/dashboard/session");
      window.location.href = "/dashboard";
    } catch (e) {
      setSignOutError(`ออกจากระบบไม่สำเร็จ: ${e.message}`);
      setSigningOut(false);
    }
  }

  if (!catalog) {
    return (
      <main className="ad-shell">
        <p className={error ? "ad-error" : "ad-muted"}>{error || "กำลังโหลด…"}</p>
        {error && <a className="ad-link" href="/dashboard">← กลับไปหน้ารายชื่อร้าน</a>}
      </main>
    );
  }

  const readOnly = catalog.shop.role !== "owner";
  const tabs = shopTabs(role);
  const activeLabel = tabs.find((item) => item.id === tab)?.label || "ไม่มีสิทธิ์เข้าถึง";
  const roleLabel = role === "owner" ? "เจ้าของร้าน" : role === "staff" ? "พนักงาน" : "ไม่พบสิทธิ์จัดการร้าน";
  return (
    <div className="merchant-layout">
      <MerchantSidebar
        groups={shopNavigation(role)}
        active={tab} onSelect={show} name={catalog.shop.name} role={roleLabel}
        onSignOut={signOut} signingOut={signingOut}
      />
      <div className="merchant-main">
        <header className="merchant-topbar">
          <div className="merchant-breadcrumb"><a href="/dashboard">ร้านทั้งหมด</a><span>/</span><b>{catalog.shop.name}</b><span>/</span>{activeLabel}</div>
          <a className="merchant-booking-link" href={`/b/${slug}`} target="_blank" rel="noreferrer">เปิดหน้าจองลูกค้า ↗</a>
        </header>
        <main className="ad-shell merchant-content">
          <div className="merchant-page-heading"><div><p>{catalog.shop.name}</p><h1>{activeLabel}</h1></div><span className="ad-status" data-tone="info">{roleLabel}</span></div>
      <header className="ad-header merchant-mobile-header">
        <div className="ad-brand">
          <a href="/dashboard" aria-label="ร้านทั้งหมด"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" /></a>
          <a className="ad-link" href="/dashboard">← ร้านทั้งหมด</a>
        </div>
        <h1>{catalog.shop.name}</h1>
        <button type="button" className="ad-link" disabled={signingOut} onClick={signOut}>{signingOut ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}</button>
        <p className="ad-muted">
          หน้าจองของลูกค้า: <a className="ad-link" href={`/b/${slug}`} target="_blank" rel="noreferrer">/b/{slug}</a>
        </p>
      </header>
      {signOutError && <p className="ad-error" role="alert">{signOutError}</p>}
      {role === "staff" && <p className="ad-notice">พนักงานจัดการการจอง ขายหน้าร้าน และปิดบิลได้ · การตั้งค่าร้านและคืนเงินเฉพาะเจ้าของร้าน</p>}
      {!tab && <p className="ad-error" role="alert">คุณไม่มีสิทธิ์เข้าถึงเมนูจัดการร้านนี้ กรุณาติดต่อเจ้าของร้าน</p>}
      <nav className="ad-tabs" role="tablist" aria-label="เมนูจัดการร้าน">
        {tabs.map(({ id: key, label }) => (
          <button type="button" key={key} role="tab" aria-selected={tab === key} data-active={tab === key} onClick={() => show(key)}>
            {label}
          </button>
        ))}
      </nav>
      <ReadOnly.Provider value={readOnly}>
        {tab === "overview" && <OverviewTab slug={slug} catalog={catalog} onNavigate={show} />}
        {tab === "bookings" && <BookingsTab slug={slug} catalog={catalog} />}
        {tab === "bills" && <BillsTab slug={slug} catalog={catalog} />}
        {tab === "flow" && <FlowTab slug={slug} catalog={catalog} version={version} onSaved={reload} />}
        {tab === "offerings" && <OfferingsTab slug={slug} catalog={catalog} onSaved={reload} />}
        {tab === "resources" && <ResourcesTab slug={slug} catalog={catalog} onSaved={reload} />}
        {tab === "hours" && <HoursTab slug={slug} catalog={catalog} onSaved={reload} />}
      </ReadOnly.Provider>
        </main>
      </div>
    </div>
  );
}

// ---------- overview (dashboard summary) ----------

function OverviewTab({ slug, catalog, onNavigate }) {
  const [day, setDay] = useState(today());
  const [bookings, setBookings] = useState(null);
  const [bills, setBills] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [bookingList, billData] = await Promise.all([
        api("GET", shopPath(slug, `/bookings?from=${day}`)),
        api("GET", shopPath(slug, `/bills?from=${day}`))
      ]);
      setBookings(Array.isArray(bookingList) ? bookingList : []);
      setBills(billData);
    } catch (e) {
      if (e.status === 401) window.location.href = "/dashboard";
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [slug, day]);

  useEffect(() => {
    setBookings(null);
    setBills(null);
    load();
  }, [load]);

  const active = (bookings ?? []).filter((b) => ACTIVE.includes(b.status));
  const upcoming = active.filter((b) => ["held", "pending", "confirmed"].includes(b.status));
  const checkedIn = active.filter((b) => b.status === "checked_in").length;
  const completed = active.filter((b) => b.status === "completed").length;
  const closed = active.filter((b) => b.status === "cancelled" || b.status === "no_show").length;
  const sum = bills?.summary;
  const walkIns = (bills?.bills ?? []).filter((b) => !b.bookingId).length;
  const resources = catalog.resources ?? [];
  const offerings = catalog.offerings ?? [];
  const activeOfferings = offerings.filter((o) => o.active).length;

  const nextBookings = active
    .slice()
    .sort((a, b) => `${a.date ?? day} ${a.start}`.localeCompare(`${b.date ?? day} ${b.start}`))
    .slice(0, 5);

  return (
    <div className="ad-stack">
      <section className="ad-card">
        <div className="ad-row ad-wrap ad-between">
          <div>
            <p className="ad-muted">สรุปการดำเนินงาน</p>
            <h2>{longDate(day)}{day === today() ? " (วันนี้)" : ""}</h2>
          </div>
          <div className="ad-row ad-wrap">
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="วันก่อนหน้า">‹</button>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="วันที่" />
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, 1))} aria-label="วันถัดไป">›</button>
            {day !== today() && <button type="button" className="ad-link" onClick={() => setDay(today())}>วันนี้</button>}
            <button type="button" className="ad-secondary" disabled={busy} onClick={load}>{busy ? "กำลังโหลด…" : "รีเฟรช"}</button>
          </div>
        </div>
        {error && <p className="ad-error" role="alert">{error}</p>}
      </section>

      <section className="ad-grid" aria-label="ตัวชี้วัดวันนี้">
        <article className="ad-card ad-metric">
          <span className="ad-muted">การจองทั้งหมด</span>
          <strong>{bookings === null ? "…" : bookings.length}</strong>
          <span className="ad-muted">{upcoming.length} รอให้บริการ · {checkedIn} มาถึงแล้ว</span>
        </article>
        <article className="ad-card ad-metric">
          <span className="ad-muted">รายรับสุทธิ</span>
          <strong>{sum ? money(sum.net) : "…"}</strong>
          <span className="ad-muted">{sum ? `${sum.closedBills} บิลปิดแล้ว` : "กำลังโหลด…"}</span>
        </article>
        <article className="ad-card ad-metric">
          <span className="ad-muted">เสร็จแล้ว</span>
          <strong>{bookings === null ? "…" : completed}</strong>
          <span className="ad-muted">{checkedIn} กำลังให้บริการ · {closed} ยกเลิก/ไม่มา</span>
        </article>
        <article className="ad-card ad-metric">
          <span className="ad-muted">ทรัพยากร / บริการ</span>
          <strong>{resources.length} / {activeOfferings}</strong>
          <span className="ad-muted">{offerings.length} บริการทั้งหมด · {catalog.shop.media?.length ?? 0} รูปร้าน</span>
        </article>
      </section>

      <div className="ad-split">
        <section className="ad-card">
          <div className="ad-row ad-between">
            <h2>การจองถัดไป</h2>
            <button type="button" className="ad-link" onClick={() => onNavigate?.("bookings")}>ดูทั้งหมด</button>
          </div>
          {!bookings && !error && <p className="ad-muted">กำลังโหลด…</p>}
          {bookings && nextBookings.length === 0 && <p className="ad-empty">ยังไม่มีการจองที่รอให้บริการ</p>}
          <ul className="ad-bookings">
            {nextBookings.map((b) => {
              const [label, tone] = STATUS[b.status] ?? [b.status, "off"];
              return (
                <li key={b.id} className="ad-booking">
                  <div className="ad-booking-time"><strong>{b.start}</strong><span>{b.end}</span></div>
                  <div className="ad-booking-main">
                    <div className="ad-row ad-wrap">
                      <strong className="ad-booking-name">{b.customer.name}</strong>
                      <span className="ad-status" data-tone={tone}>{label}</span>
                    </div>
                    <div className="ad-muted">
                      {b.offering.name}
                      {b.resources.length ? ` · ${b.resources.map((r) => r.name).join(", ")}` : ""}
                      {b.partySize > 1 ? ` · ${b.partySize} คน` : ""}
                      {b.price ? ` · ${money(b.price)}` : ""}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="ad-card">
          <div className="ad-row ad-between">
            <h2>รายรับและบิล</h2>
            <button type="button" className="ad-link" onClick={() => onNavigate?.("bills")}>ดูทั้งหมด</button>
          </div>
          {sum && (
            <dl className="ad-totals">
              <div data-main="true"><dt>รับสุทธิ</dt><dd>{money(sum.net)}</dd></div>
              {Object.entries(METHODS).map(([k, v]) => (sum.byMethod[k] ? <div key={k}><dt>{v}</dt><dd>{money(sum.byMethod[k])}</dd></div> : null))}
              {sum.refunds > 0 && <div><dt>คืนเงิน</dt><dd>−{money(sum.refunds)}</dd></div>}
              <div><dt>จำนวนบิล</dt><dd>{sum.closedBills}</dd></div>
              <div><dt>ขายหน้าร้าน</dt><dd>{walkIns}</dd></div>
            </dl>
          )}
          {!sum && !error && <p className="ad-muted">กำลังโหลด…</p>}
          {(bills?.bills ?? []).length > 0 && (
            <ul className="ad-bookings">
              {(bills.bills ?? []).slice(0, 5).map((b) => (
                <li key={b.id} className="ad-booking">
                  <div className="ad-booking-time"><strong>{b.time}</strong></div>
                  <div className="ad-booking-main">
                    <div className="ad-row ad-wrap">
                      <strong className="ad-booking-name">{b.title}</strong>
                      {b.status !== "closed" && <span className="ad-status" data-tone="warn">ยังไม่ปิด</span>}
                      {!b.bookingId && <span className="ad-status" data-tone="info">ขายหน้าร้าน</span>}
                    </div>
                    <div className="ad-muted">{b.customerName ? `${b.customerName} · ` : ""}{money(b.total)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="ad-card">
        <h2>ทางลัด</h2>
        <div className="ad-row ad-wrap">
          <button type="button" className="ad-primary" onClick={() => onNavigate?.("bookings")}>+ เพิ่มการจอง</button>
          <button type="button" className="ad-secondary" onClick={() => onNavigate?.("bills")}>+ ขายหน้าร้าน</button>
          <button type="button" className="ad-secondary" onClick={() => onNavigate?.("offerings")}>จัดการบริการ</button>
          <button type="button" className="ad-secondary" onClick={() => onNavigate?.("resources")}>จัดการสนาม/ช่าง</button>
          <button type="button" className="ad-secondary" onClick={() => onNavigate?.("hours")}>เวลาทำการ</button>
        </div>
        <p className="ad-muted">ภาพร้านและบริการแก้ได้ในแท็บ “บริการและราคา” และ “ร้านและเวลาทำการ”</p>
      </section>
    </div>
  );
}
const STATUS = {
  held: ["รอชำระ", "warn"],
  pending: ["รอยืนยัน", "warn"],
  confirmed: ["ยืนยันแล้ว", "info"],
  checked_in: ["มาถึงแล้ว", "ok"],
  completed: ["เสร็จแล้ว", "done"],
  cancelled: ["ยกเลิก", "off"],
  no_show: ["ไม่มา", "off"],
  expired: ["หมดเวลา", "off"]
};
const SOURCE = { web: "จองผ่านเว็บ", liff: "จองผ่าน LINE", line_chat: "แชท LINE", admin: "ร้านบันทึก" };
const ACTIVE = ["held", "pending", "confirmed", "checked_in", "completed"];

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const longDate = (date) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T00:00:00Z`));

function BookingsTab({ slug, catalog }) {
  const [day, setDay] = useState(today);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // { booking? } while the form is open
  const [checkout, setCheckout] = useState(null); // the booking whose bill is being closed
  const [showOff, setShowOff] = useState(false);
  const save = useSave();

  const load = useCallback(async () => {
    try {
      setList(await api("GET", shopPath(slug, `/bookings?from=${day}`)));
      setError("");
    } catch (e) {
      if (e.status === 401) window.location.href = "/dashboard";
      setError(e.message);
    }
  }, [slug, day]);

  useEffect(() => {
    setList(null);
    load();
    // keep the desk's list fresh while it stays open
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(booking, path, body, done) {
    if (await save.run(() => api("POST", shopPath(slug, `/bookings/${booking.id}/${path}`), body), done)) load();
  }

  function cancel(booking) {
    const reason = window.prompt(`ยกเลิกการจองของ ${booking.customer.name} เวลา ${booking.start}?\nเหตุผล (ไม่บังคับ)`, "");
    if (reason === null) return;
    act(booking, "cancel", { reason }, "ยกเลิกแล้ว");
  }

  function noShow(booking) {
    if (!window.confirm(`บันทึกว่า ${booking.customer.name} ไม่มา? ช่วงเวลานี้จะว่างให้คนอื่นจอง`)) return;
    act(booking, "status", { status: "no_show" }, "บันทึกว่าไม่มา");
  }

  const active = (list ?? []).filter((b) => ACTIVE.includes(b.status));
  const shown = showOff ? list ?? [] : active;
  const off = (list?.length ?? 0) - active.length;
  const count = (status) => active.filter((b) => b.status === status).length;

  return (
    <div className="ad-stack">
      <section className="ad-card">
        <div className="ad-row ad-wrap ad-between">
          <div className="ad-row ad-wrap">
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="วันก่อนหน้า">‹</button>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="วันที่" />
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, 1))} aria-label="วันถัดไป">›</button>
            {day !== today() && <button type="button" className="ad-link" onClick={() => setDay(today())}>วันนี้</button>}
          </div>
          <button type="button" className="ad-primary" onClick={() => setForm({})}>+ เพิ่มการจอง</button>
        </div>
        <div>
          <h2>{longDate(day)}{day === today() ? " (วันนี้)" : ""}</h2>
          {list && (
            <p className="ad-muted">
              {active.length} การจอง
              {count("checked_in") ? ` · มาถึงแล้ว ${count("checked_in")}` : ""}
              {count("completed") ? ` · เสร็จแล้ว ${count("completed")}` : ""}
              {off > 0 && (
                <>
                  {" · "}
                  <button type="button" className="ad-link" onClick={() => setShowOff(!showOff)}>
                    {showOff ? "ซ่อน" : "แสดง"}ที่ยกเลิก/ไม่มา ({off})
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <Status save={save} />
        {error && <p className="ad-error">{error}</p>}
        {!list && !error && <p className="ad-muted">กำลังโหลด…</p>}
        {list && shown.length === 0 && <p className="ad-empty">ยังไม่มีการจองในวันนี้</p>}
        <ul className="ad-bookings">
          {shown.map((b) => {
            const [label, tone] = STATUS[b.status] ?? [b.status, "off"];
            const open = ["held", "pending", "confirmed"].includes(b.status);
            const paid = b.bill?.status === "closed";
            const billable = !paid && ["pending", "confirmed", "checked_in", "completed"].includes(b.status);
            return (
              <li key={b.id} className="ad-booking" data-tone={tone}>
                <div className="ad-booking-time">
                  <strong>{b.start}</strong>
                  <span>{b.end}</span>
                </div>
                <div className="ad-booking-main">
                  <div className="ad-row ad-wrap">
                    <strong className="ad-booking-name">{b.customer.name}</strong>
                    <span className="ad-status" data-tone={tone}>{label}</span>
                    {paid && <span className="ad-status" data-tone="ok">ชำระแล้ว {money(b.bill.paid)}</span>}
                  </div>
                  <div className="ad-muted">
                    {b.offering.name}
                    {b.resources.length ? ` · ${b.resources.map((r) => r.name).join(", ")}` : ""}
                    {b.partySize > 1 ? ` · ${b.partySize} คน` : ""}
                    {b.price ? ` · ${money(b.price)}` : ""}
                  </div>
                  <div className="ad-muted">
                    {b.customer.phone && <a className="ad-link" href={`tel:${b.customer.phone}`}>{b.customer.phone}</a>}
                    {b.customer.phone ? " · " : ""}
                    {SOURCE[b.source] ?? b.source}
                    {b.statusReason === "บันทึกย้อนหลัง" ? " (ย้อนหลัง)" : ""}
                    {b.status === "held" && b.holdExpiresAt
                      ? ` · รอถึง ${new Date(b.holdExpiresAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}`
                      : ""}
                  </div>
                  {b.notes && <p className="ad-booking-notes">{b.notes}</p>}
                  {b.statusReason && ["cancelled", "no_show"].includes(b.status) && <p className="ad-booking-notes">{b.statusReason}</p>}
                </div>
                <div className="ad-booking-actions">
                  {open && b.status !== "held" && (
                    <button type="button" className="ad-primary" disabled={save.busy} onClick={() => act(b, "status", { status: "checked_in" }, `${b.customer.name} มาถึงแล้ว`)}>มาถึงแล้ว</button>
                  )}
                  {billable && (
                    <button type="button" className={["checked_in", "completed"].includes(b.status) ? "ad-primary" : "ad-secondary"} disabled={save.busy} onClick={() => setCheckout(b)}>ปิดบิล</button>
                  )}
                  {b.status === "checked_in" && (
                    <button type="button" className="ad-secondary" disabled={save.busy} onClick={() => act(b, "status", { status: "completed" }, "บันทึกว่าเสร็จแล้ว")}>เสร็จแล้ว</button>
                  )}
                  {open && <button type="button" className="ad-secondary" disabled={save.busy} onClick={() => setForm({ booking: b })}>เลื่อน</button>}
                  {open && <button type="button" className="ad-link" disabled={save.busy} onClick={() => cancel(b)}>ยกเลิก</button>}
                  {open && b.status !== "held" && <button type="button" className="ad-link" disabled={save.busy} onClick={() => noShow(b)}>ไม่มา</button>}
                  {b.status === "checked_in" && (
                    <button type="button" className="ad-link" disabled={save.busy} onClick={() => act(b, "status", { status: "confirmed" }, "ย้อนกลับแล้ว")}>ย้อนกลับ</button>
                  )}
                  {b.status === "completed" && !paid && (
                    <button type="button" className="ad-link" disabled={save.busy} onClick={() => act(b, "status", { status: "checked_in" }, "ย้อนกลับแล้ว")}>ย้อนกลับ</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {checkout && (
        <CheckoutForm
          key={checkout.id}
          slug={slug}
          booking={checkout}
          onClose={() => setCheckout(null)}
          onSaved={() => {
            setCheckout(null);
            load();
          }}
        />
      )}
      {form && (
        <BookingForm
          key={form.booking?.id ?? "new"}
          slug={slug}
          catalog={catalog}
          booking={form.booking}
          defaultDate={day}
          onClose={() => setForm(null)}
          onSaved={(date) => {
            setForm(null);
            if (date !== day) setDay(date);
            else load();
          }}
        />
      )}
    </div>
  );
}

// ---------- bills (members, staff included; refunds owner-only) ----------

const METHODS = { cash: "เงินสด", transfer: "โอน", card: "บัตร", online: "ออนไลน์" };
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** How the customer paid: one or more lines that must add up to `due` */
function PaymentLines({ lines, setLines, due }) {
  const paid = round2(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0));
  const left = round2(due - paid);
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="ad-field">
      ชำระโดย
      {lines.map((l, i) => (
        <div key={i} className="ad-row ad-wrap">
          <select value={l.method} onChange={(e) => setLine(i, { method: e.target.value })} aria-label={`ช่องทางที่ ${i + 1}`}>
            {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="number" min={0} step="0.01" inputMode="decimal" className="ad-short" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} aria-label={`ยอดช่องทางที่ ${i + 1}`} />
          {lines.length > 1 && <button type="button" className="ad-link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>ลบ</button>}
        </div>
      ))}
      <div className="ad-row ad-wrap">
        {lines.length < 4 && (
          <button type="button" className="ad-link" onClick={() => setLines([...lines, { method: "transfer", amount: left > 0 ? String(left) : "" }])}>+ แยกจ่ายหลายช่องทาง</button>
        )}
        <span className={left === 0 ? "ad-ok" : "ad-error"} role="status">
          {left === 0 ? "ยอดครบ" : left > 0 ? `ขาดอีก ${money(left)}` : `เกิน ${money(-left)}`}
        </span>
      </div>
    </div>
  );
}

const toPayments = (lines) => lines.map((l) => ({ method: l.method, amount: Number(l.amount) || 0 }));

/** Close a booking's bill after the visit: the amount (editable) and how it was paid */
function CheckoutForm({ slug, booking, onClose, onSaved }) {
  const [subtotal, setSubtotal] = useState(String(booking.price ?? 0));
  const [lines, setLines] = useState([{ method: "cash", amount: String(booking.price ?? 0) }]);
  const [note, setNote] = useState("");
  const save = useSave();
  const due = round2(subtotal);

  function changeSubtotal(value) {
    setSubtotal(value);
    // one payment line follows the amount until the shop splits it
    if (lines.length === 1) setLines([{ ...lines[0], amount: value }]);
  }

  async function submit(event) {
    event.preventDefault();
    const ok = await save.run(
      () => api("POST", shopPath(slug, `/bookings/${booking.id}/checkout`), { subtotal: due, payments: toPayments(lines), note }),
      "ปิดบิลแล้ว"
    );
    if (ok) onSaved();
  }

  return (
    <form className="ad-card" onSubmit={submit}>
      <div className="ad-row ad-between">
        <h2>ปิดบิล · {booking.customer.name}</h2>
        <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
      </div>
      <p className="ad-muted">{booking.offering.name} · {booking.start}–{booking.end}{booking.resources.length ? ` · ${booking.resources.map((r) => r.name).join(", ")}` : ""}</p>
      <div className="ad-grid">
        <label className="ad-field">
          ยอดรวม (บาท) — แก้ได้ถ้าลูกค้าเพิ่มหรือเปลี่ยนบริการ
          <input type="number" min={0} step="0.01" inputMode="decimal" required value={subtotal} onChange={(e) => changeSubtotal(e.target.value)} />
        </label>
        <label className="ad-field">โน้ต (ไม่บังคับ)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></label>
      </div>
      <PaymentLines lines={lines} setLines={setLines} due={due} />
      <Status save={save} />
      <div className="ad-row">
        <button className="ad-primary" disabled={save.busy}>รับเงิน {money(due)} และปิดบิล</button>
        <button type="button" className="ad-secondary" onClick={onClose}>ยกเลิก</button>
      </div>
    </form>
  );
}

/** A sale with no booking: a walk-in, or a shop that takes no bookings */
function SaleForm({ slug, onClose, onSaved }) {
  const [f, setF] = useState({ title: "", customerName: "", amount: "", note: "" });
  const [lines, setLines] = useState([{ method: "cash", amount: "" }]);
  const save = useSave();
  const due = round2(f.amount);

  function changeAmount(value) {
    setF({ ...f, amount: value });
    if (lines.length === 1) setLines([{ ...lines[0], amount: value }]);
  }

  async function submit(event) {
    event.preventDefault();
    const ok = await save.run(() => api("POST", shopPath(slug, "/bills"), { ...f, amount: due, payments: toPayments(lines) }), "บันทึกการขายแล้ว");
    if (ok) onSaved();
  }

  return (
    <form className="ad-card" onSubmit={submit}>
      <div className="ad-row ad-between">
        <h2>ขายหน้าร้าน</h2>
        <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
      </div>
      <div className="ad-grid">
        <label className="ad-field">รายการ<input value={f.title} placeholder="ขายหน้าร้าน" maxLength={100} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="ad-field">ยอด (บาท)<input type="number" min={0} step="0.01" inputMode="decimal" required value={f.amount} onChange={(e) => changeAmount(e.target.value)} /></label>
        <label className="ad-field">ชื่อลูกค้า (ไม่บังคับ)<input value={f.customerName} maxLength={100} onChange={(e) => setF({ ...f, customerName: e.target.value })} autoComplete="off" /></label>
        <label className="ad-field">โน้ต (ไม่บังคับ)<input value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      </div>
      <PaymentLines lines={lines} setLines={setLines} due={due} />
      <Status save={save} />
      <div className="ad-row">
        <button className="ad-primary" disabled={save.busy}>บันทึกการขาย {money(due)}</button>
        <button type="button" className="ad-secondary" onClick={onClose}>ยกเลิก</button>
      </div>
    </form>
  );
}

/** Refund part or all of a closed bill (owners only) */
function RefundForm({ slug, bill, onClose, onSaved }) {
  const left = round2(bill.paid - bill.refunded);
  const [f, setF] = useState({ amount: String(left), method: "cash", reason: "" });
  const save = useSave();

  async function submit(event) {
    event.preventDefault();
    const ok = await save.run(() => api("POST", shopPath(slug, `/bills/${bill.id}/refund`), { ...f, amount: round2(f.amount) }), "คืนเงินแล้ว");
    if (ok) onSaved();
  }

  return (
    <form className="ad-card" onSubmit={submit}>
      <div className="ad-row ad-between">
        <h2>คืนเงิน · {bill.title}</h2>
        <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
      </div>
      <p className="ad-muted">คืนได้ไม่เกิน {money(left)}</p>
      <div className="ad-grid">
        <label className="ad-field">ยอดที่คืน (บาท)<input type="number" min={0.01} max={left} step="0.01" inputMode="decimal" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="ad-field">
          คืนทาง
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="ad-field">เหตุผล (ไม่บังคับ)<input value={f.reason} maxLength={200} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      </div>
      <Status save={save} />
      <div className="ad-row">
        <button className="ad-danger" disabled={save.busy}>คืนเงิน {money(round2(f.amount))}</button>
        <button type="button" className="ad-secondary" onClick={onClose}>ยกเลิก</button>
      </div>
    </form>
  );
}

const paymentText = (payments) =>
  payments
    .filter((p) => p.kind !== "refund")
    .map((p) => `${METHODS[p.method] ?? p.method} ${money(p.amount)}`)
    .join(" + ");

function BillsTab({ slug, catalog }) {
  const [day, setDay] = useState(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // { sale: true } or { refund: bill }
  const owner = catalog.shop.role === "owner";

  const load = useCallback(async () => {
    try {
      setData(await api("GET", shopPath(slug, `/bills?from=${day}`)));
      setError("");
    } catch (e) {
      if (e.status === 401) window.location.href = "/dashboard";
      setError(e.message);
    }
  }, [slug, day]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  function saved() {
    setForm(null);
    if (day !== today()) setDay(today());
    else load();
  }

  const sum = data?.summary;
  return (
    <div className="ad-stack">
      <section className="ad-card">
        <div className="ad-row ad-wrap ad-between">
          <div className="ad-row ad-wrap">
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="วันก่อนหน้า">‹</button>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="วันที่" />
            <button type="button" className="ad-secondary ad-icon-btn" onClick={() => setDay(addDays(day, 1))} aria-label="วันถัดไป">›</button>
            {day !== today() && <button type="button" className="ad-link" onClick={() => setDay(today())}>วันนี้</button>}
          </div>
          <button type="button" className="ad-primary" onClick={() => setForm({ sale: true })}>+ ขายหน้าร้าน</button>
        </div>
        <h2>รายรับ {longDate(day)}{day === today() ? " (วันนี้)" : ""}</h2>
        {sum && (
          <dl className="ad-totals">
            <div data-main="true"><dt>รับสุทธิ</dt><dd>{money(sum.net)}</dd></div>
            {Object.entries(METHODS).map(([k, v]) => (sum.byMethod[k] ? <div key={k}><dt>{v}</dt><dd>{money(sum.byMethod[k])}</dd></div> : null))}
            {sum.refunds > 0 && <div><dt>คืนเงิน</dt><dd>−{money(sum.refunds)}</dd></div>}
            <div><dt>จำนวนบิล</dt><dd>{sum.closedBills}</dd></div>
          </dl>
        )}
        {error && <p className="ad-error">{error}</p>}
        {!data && !error && <p className="ad-muted">กำลังโหลด…</p>}
        {data && data.bills.length === 0 && <p className="ad-empty">ยังไม่มีบิลในวันนี้ · ปิดบิลจากแท็บ "การจอง" หรือกด "ขายหน้าร้าน"</p>}
        <ul className="ad-bookings">
          {(data?.bills ?? []).map((b) => (
            <li key={b.id} className="ad-booking">
              <div className="ad-booking-time"><strong>{b.time}</strong></div>
              <div className="ad-booking-main">
                <div className="ad-row ad-wrap">
                  <strong className="ad-booking-name">{b.title}</strong>
                  {b.status !== "closed" && <span className="ad-status" data-tone="warn">ยังไม่ปิด</span>}
                  {!b.bookingId && <span className="ad-status" data-tone="info">ขายหน้าร้าน</span>}
                </div>
                <div className="ad-muted">
                  {b.customerName ? `${b.customerName} · ` : ""}
                  {money(b.total)}
                  {paymentText(b.payments) ? ` · ${paymentText(b.payments)}` : ""}
                </div>
                {b.refunded > 0 && (
                  <p className="ad-booking-notes">
                    คืนเงิน {money(b.refunded)}
                    {b.payments.filter((p) => p.kind === "refund" && p.note).map((p) => ` · ${p.note}`).join("")}
                  </p>
                )}
                {b.note && <p className="ad-booking-notes">{b.note}</p>}
              </div>
              <div className="ad-booking-actions">
                {owner && b.status === "closed" && b.paid - b.refunded > 0 && (
                  <button type="button" className="ad-link" onClick={() => setForm({ refund: b })}>คืนเงิน</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {form?.sale && <SaleForm slug={slug} onClose={() => setForm(null)} onSaved={saved} />}
      {form?.refund && <RefundForm key={form.refund.id} slug={slug} bill={form.refund} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

const PAST_STATUS = [
  ["completed", "ใช้บริการแล้ว"],
  ["checked_in", "กำลังใช้บริการ"],
  ["no_show", "ไม่มา"]
];

function durationsOf(offering) {
  if (offering?.durationMode !== "customer_choice") return [];
  const out = [];
  for (let m = offering.minMinutes; m <= offering.maxMinutes; m += offering.stepMinutes) out.push(m);
  return out;
}

/** A new booking (phone call, walk-in) or moving one: free times are suggested, any time can be typed */
function BookingForm({ slug, catalog, booking, defaultDate, onClose, onSaved }) {
  const offerings = catalog.offerings.filter((o) => o.active || o.id === booking?.offering.id);
  const [f, setF] = useState(() => {
    const offeringId = booking?.offering.id ?? offerings[0]?.id ?? "";
    const durations = durationsOf(catalog.offerings.find((o) => o.id === offeringId));
    return {
      offeringId,
      resourceId: "",
      date: booking?.date ?? defaultDate,
      time: booking?.start ?? "",
      durationMinutes: durations[0] ?? "",
      partySize: booking?.partySize ?? 1,
      name: "",
      phone: "",
      notes: "",
      status: "completed"
    };
  });
  const [free, setFree] = useState(null);
  const save = useSave();
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const offering = catalog.offerings.find((o) => o.id === f.offeringId);
  const resources = catalog.resources.filter((r) => r.active && offering?.resourceIds.includes(r.id));
  const durations = durationsOf(offering);
  // a new booking whose start has passed records a visit afterwards
  const past = !booking && Boolean(f.date && f.time) && `${f.date}T${f.time}` < nowLocal();

  function chooseOffering(id) {
    set({ offeringId: id, resourceId: "", time: "", durationMinutes: durationsOf(catalog.offerings.find((o) => o.id === id))[0] ?? "" });
  }

  useEffect(() => {
    if (!f.offeringId || !f.date) return undefined;
    const q = new URLSearchParams({ offeringId: f.offeringId, date: f.date });
    if (f.resourceId) q.set("resourceId", f.resourceId);
    if (f.durationMinutes) q.set("durationMinutes", f.durationMinutes);
    if (Number(f.partySize) > 1) q.set("partySize", f.partySize);
    if (booking) q.set("excludeBookingId", booking.id);
    let live = true;
    setFree(null);
    api("GET", shopPath(slug, `/free-times?${q}`)).then(
      (r) => live && setFree(r),
      () => live && setFree({ times: [] })
    );
    return () => {
      live = false;
    };
  }, [slug, booking, f.offeringId, f.date, f.resourceId, f.durationMinutes, f.partySize]);

  async function submit(event) {
    event.preventDefault();
    const common = {
      date: f.date,
      time: f.time,
      resourceId: f.resourceId || null,
      durationMinutes: f.durationMinutes ? Number(f.durationMinutes) : null
    };
    const ok = await save.run(() =>
      booking
        ? api("PUT", shopPath(slug, `/bookings/${booking.id}`), common)
        : api("POST", shopPath(slug, "/bookings"), {
            ...common,
            offeringId: f.offeringId,
            partySize: Number(f.partySize) || 1,
            customer: { name: f.name, phone: f.phone },
            notes: f.notes,
            ...(past ? { status: f.status } : {})
          })
    );
    if (ok) onSaved(f.date);
  }

  return (
    <form className="ad-card" onSubmit={submit}>
      <div className="ad-row ad-between">
        <h2>{booking ? `เลื่อนนัด ${booking.customer.name}` : "เพิ่มการจอง"}</h2>
        <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
      </div>
      {booking ? (
        <p className="ad-muted">{booking.offering.name} · เดิม {longDate(booking.date)} {booking.start}–{booking.end}</p>
      ) : (
        <div className="ad-grid">
          <label className="ad-field">
            บริการ
            <select required value={f.offeringId} onChange={(e) => chooseOffering(e.target.value)}>
              {offerings.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          {offering?.maxPartySize > 1 && (
            <label className="ad-field">
              จำนวนคน
              <input type="number" min={1} max={offering.maxPartySize} value={f.partySize} onChange={(e) => set({ partySize: e.target.value })} />
            </label>
          )}
        </div>
      )}
      <div className="ad-grid">
        <label className="ad-field">
          {resources[0] ? RESOURCE_KINDS[resources[0].kind] ?? resources[0].kind : "ช่าง / สนาม"}
          <select value={f.resourceId} onChange={(e) => set({ resourceId: e.target.value })}>
            <option value="">{booking ? "คนเดิม / ระบบเลือกให้" : "ใครก็ได้ (ระบบเลือกตัวที่ว่าง)"}</option>
            {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        {durations.length > 0 && (
          <label className="ad-field">
            ระยะเวลา
            <select value={f.durationMinutes} onChange={(e) => set({ durationMinutes: e.target.value })}>
              {durations.map((m) => <option key={m} value={m}>{minutes(m)}</option>)}
            </select>
          </label>
        )}
        <label className="ad-field">วันที่<input type="date" required value={f.date} onChange={(e) => set({ date: e.target.value })} /></label>
        <label className="ad-field">เวลาเริ่ม<input type="time" required step={300} value={f.time} onChange={(e) => set({ time: e.target.value })} /></label>
      </div>
      <div className="ad-field">
        เวลาที่ยังว่าง (กดเลือก หรือพิมพ์เวลาเองในช่องเวลาเริ่ม)
        {free === null ? (
          <span className="ad-muted">กำลังดู…</span>
        ) : free.times.length === 0 ? (
          <span className="ad-muted">{!booking && f.date < today() ? "วันที่ผ่านมาแล้ว — พิมพ์เวลาเริ่มเองเพื่อบันทึกย้อนหลัง" : "ไม่มีช่วงที่ว่างในวันนั้น"}</span>
        ) : (
          <div className="ad-chips">
            {free.times.map((t) => (
              <button key={t} type="button" className="ad-chip" data-on={f.time === t} onClick={() => set({ time: t })}>{t}</button>
            ))}
          </div>
        )}
      </div>
      {past && (
        <div className="ad-field">
          เวลานี้ผ่านไปแล้ว — บันทึกย้อนหลังเป็น
          <div className="ad-chips">
            {PAST_STATUS.map(([value, label]) => (
              <button key={value} type="button" className="ad-chip" data-on={f.status === value} onClick={() => set({ status: value })}>{label}</button>
            ))}
          </div>
        </div>
      )}
      {!booking && (
        <div className="ad-grid">
          <label className="ad-field">ชื่อลูกค้า<input required value={f.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" /></label>
          <label className="ad-field">เบอร์โทร (ไม่บังคับ)<input type="tel" inputMode="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} autoComplete="off" /></label>
          <label className="ad-field">โน้ต (ไม่บังคับ)<input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
        </div>
      )}
      <Status save={save} />
      <div className="ad-row">
        <button className="ad-primary" disabled={save.busy}>{booking ? "เลื่อนนัด" : past ? "บันทึกย้อนหลัง" : "บันทึกการจอง"}</button>
        <button type="button" className="ad-secondary" onClick={onClose}>ปิด</button>
      </div>
    </form>
  );
}

// ---------- booking flow ----------

function FlowTab({ slug, catalog, version, onSaved }) {
  const initial = useMemo(() => bookingFlowDraft(catalog.flow), [catalog]);
  const [draft, setDraft] = useState(initial);
  const [templateId, setTemplateId] = useState("");
  useEffect(() => { setDraft(initial); setTemplateId(""); }, [initial]);
  const save = useSave();
  const flow = bookingFlowFromDraft(draft);
  const templatePreview = templateId ? previewBookingTemplate(templateId, catalog, flow) : null;
  const word = resourceWord(catalog);
  const paths = previewPaths(flow, catalog);
  const warnings = catalogWarnings(flow, catalog);
  const changed = JSON.stringify(flow) !== JSON.stringify(catalog.flow);

  const toggleEntry = (step) =>
    setDraft((d) => ({ ...d, entry: d.entry.includes(step) ? d.entry.filter((s) => s !== step) : [...d.entry, step] }));
  const setMode = (step, mode) => setDraft((d) => ({ ...d, modes: { ...d.modes, [step]: mode } }));
  const entryChoices = [
    ["date", "เลือกวันก่อน"],
    ["offering", "เลือกบริการก่อน"],
    ["resource", `เลือก${word}ก่อน`]
  ];
  const chosen = [...flow.require, ...flow.optional];
  if (catalog.shop.role !== "owner") return null;

  return (
    <div className="ad-split">
      <section className="ad-card">
        <h2>ขั้นตอนจองของลูกค้า</h2>
        <Locked>
        <div className="ad-field">
          <label htmlFor="booking-template">ดูแบบขั้นตอนจอง</label>
          <select id="booking-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">ขั้นตอนปัจจุบัน / กำหนดเอง (ไม่เปลี่ยน)</option>
            {BOOKING_TEMPLATES.map((template) => {
              const available = previewBookingTemplate(template.id, catalog, flow).applicable;
              return <option key={template.id} value={template.id}>{template.label} — {available ? "ใช้กับข้อมูลร้านนี้ได้" : template.status === "planned" ? "อยู่ในแผน · ยังใช้ไม่ได้" : "ข้อมูลร้านยังไม่รองรับ"}</option>;
            })}
          </select>
          <p className="ad-muted">การดูแบบไม่เปลี่ยนขั้นตอนปัจจุบัน เลือกใช้กับแบบร่างแล้วกด “บันทึกขั้นตอนจอง” เองเท่านั้น · ไม่แก้บริการ ทรัพยากร ราคา หรือการตั้งค่าร้าน</p>
        </div>
        {templatePreview && (
          <div className="ad-notice" aria-live="polite">
            <h3>{templatePreview.template.label}</h3>
            <p>{templatePreview.template.description}</p>
            {templatePreview.template.limitation && <p>{templatePreview.template.limitation}</p>}
            {templatePreview.errors.length > 0 && <ul>{templatePreview.errors.map((error) => <li key={error.code + error.message}>{error.message}</li>)}</ul>}
            {templatePreview.flow && previewPaths(templatePreview.flow, catalog).map((path) => (
              <p key={path.entry}>ตัวอย่างแบบ: {path.steps.map((step) => step.label).join(" → ")}</p>
            ))}
            <button type="button" className="ad-secondary" disabled={!templatePreview.applicable || save.busy} onClick={() => {
              const preview = previewBookingTemplate(templateId, catalog, flow);
              if (preview.applicable) setDraft(bookingFlowDraft(preview.flow));
            }}>ใช้แบบนี้กับแบบร่าง (ยังไม่บันทึก)</button>
          </div>
        )}

        <div className="ad-field">
          ลูกค้าเริ่มจากอะไรได้บ้าง (เลือกหลายทาง = ลูกค้าเลือกเองที่หน้าแรก)
          <div className="ad-checks">
            {entryChoices.map(([step, label]) => (
              <label key={step} className={chosen.includes(step) ? "" : "ad-disabled"}>
                <input type="checkbox" checked={draft.entry.includes(step) && chosen.includes(step)} disabled={!chosen.includes(step)} onChange={() => toggleEntry(step)} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="ad-field">
          ขั้นที่ลูกค้าเลือก
          <table className="ad-table">
            <tbody>
              <tr><td>บริการ · วัน · เวลาเริ่ม</td><td className="ad-muted">ต้องเลือกเสมอ</td></tr>
              {[
                ["resource", `เลือก${word}`, ["off", "optional", "require"]],
                ["duration", "เลือกระยะเวลา (บริการที่ให้ลูกค้าเลือก)", ["off", "require"]],
                ["party", "เลือกจำนวนคน (บริการที่จองได้หลายคน)", ["off", "require"]]
              ].map(([step, label, allowed]) => (
                <tr key={step}>
                  <td>{label}</td>
                  <td>
                    <select value={draft.modes[step]} onChange={(e) => setMode(step, e.target.value)} aria-label={label}>
                      {allowed.includes("off") && <option value="off">ไม่ใช้</option>}
                      {allowed.includes("optional") && <option value="optional">เลือกหรือไม่ก็ได้</option>}
                      <option value="require">ต้องเลือก</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {draft.modes.resource === "optional" && (
          <label className="ad-check">
            <input type="checkbox" checked={draft.showAnyStaff} onChange={(e) => setDraft({ ...draft, showAnyStaff: e.target.checked })} />
            มีปุ่ม “ใครก็ได้” ให้ระบบเลือก{word}ที่ว่างให้
          </label>
        )}
        <label className="ad-field ad-short">
          ปฏิทินแสดงล่วงหน้า (วัน) — เว้นว่าง = ตามที่ร้านเปิดให้จอง ({catalog.settings.maxAdvanceDays} วัน)
          <input type="number" min={1} max={365} value={draft.dateRangeDays} onChange={(e) => setDraft({ ...draft, dateRangeDays: e.target.value })} />
        </label>

        {flow.entry.length === 0 && <p className="ad-error">เลือกทางเริ่มอย่างน้อย 1 ทาง</p>}
        <Status save={save} />
        <div className="ad-row">
          <button
            className="ad-primary"
            disabled={save.busy || !changed || flow.entry.length === 0}
            onClick={async () => {
              if (await save.run(() => api("PUT", shopPath(slug, "/flow"), flow))) onSaved();
            }}
          >
            บันทึกขั้นตอนจอง
          </button>
          {changed && <button type="button" className="ad-secondary" onClick={() => setDraft(initial)}>ยกเลิกที่แก้</button>}
        </div>
        </Locked>
      </section>

      <section className="ad-card">
        <h2>ตัวอย่างที่ลูกค้าจะเห็น {changed && <small className="ad-badge">ยังไม่บันทึก</small>}</h2>
        {flow.entry.length > 1 && <p className="ad-muted">หน้าแรกมีปุ่มให้ลูกค้าเลือก: {flow.entry.map((e) => paths.find((p) => p.entry === e).steps[0].label).join(" หรือ ")}</p>}
        {paths.map((path) => (
          <ol key={path.entry} className="ad-steps" aria-label={`เริ่มจาก ${path.steps[0].label}`}>
            {path.steps.map((s) => (
              <li key={s.step} data-skip={Boolean(s.note?.startsWith("ข้ามเสมอ"))}>
                <strong>{s.label}</strong>
                {s.optional && <span className="ad-muted"> (ไม่บังคับ)</span>}
                {s.note && <small className="ad-muted"> — {s.note}</small>}
              </li>
            ))}
          </ol>
        ))}
        {warnings.length > 0 && (
          <ul className="ad-warnings">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        <div className="ad-phone">
          <iframe key={version} title="หน้าจองจริง" src={`/b/${slug}`} />
        </div>
        <p className="ad-muted">หน้าจองจริง (แสดงขั้นตอนที่บันทึกแล้ว) · <a className="ad-link" href={`/b/${slug}`} target="_blank" rel="noreferrer">เปิดในแท็บใหม่</a></p>
      </section>
    </div>
  );
}

// ---------- offerings and prices ----------

// A new offering needs what the shop already has (its courts, or its stylists), all of them
function emptyOffering(catalog) {
  const resources = catalog.resources.filter((r) => r.active);
  const kind = resources[0]?.kind ?? (catalog.shop.kind === "court" ? "court" : "staff");
  return {
    id: null,
    name: "",
    category: "",
    description: "",
    media: [],
    durationMode: "fixed",
    durationMinutes: 60,
    minMinutes: 60,
    maxMinutes: 180,
    stepMinutes: 60,
    bufferAfterMinutes: 0,
    maxPartySize: 1,
    sortOrder: 0,
    active: true,
    requirements: [{ kind, customerPicks: true, unitsPerBooking: "one" }],
    resourceIds: resources.filter((r) => r.kind === kind).map((r) => r.id),
    prices: [{ unit: "per_booking", amount: "", daysOfWeek: null, start: null, end: null, priority: null }]
  };
}

function priceSummary(o) {
  if (!o.prices.length) return "ยังไม่มีราคา";
  const base = o.prices.reduce((a, b) => (b.amount < a.amount ? b : a));
  return `${o.prices.length > 1 ? "เริ่ม " : ""}${money(base.amount)} ${UNITS[base.unit]}`;
}

function OfferingsTab({ slug, catalog, onSaved }) {
  const [editing, setEditing] = useState(null);
  const readOnly = useContext(ReadOnly);
  const open = (o) => setEditing(o ? structuredClone(o) : emptyOffering(catalog));
  // after a save, keep showing the saved offering (a new one closes)
  useEffect(() => setEditing((e) => (e?.id ? structuredClone(catalog.offerings.find((o) => o.id === e.id) ?? null) : null)), [catalog]);

  return (
    <div className="ad-split">
      <section className="ad-card">
        <div className="ad-row ad-between">
          <h2>บริการ</h2>
          {!readOnly && <button className="ad-secondary" onClick={() => open(null)}>+ เพิ่มบริการ</button>}
        </div>
        {catalog.offerings.length === 0 && <p className="ad-muted">ยังไม่มีบริการ</p>}
        <ul className="ad-list">
          {catalog.offerings.map((o) => (
            <li key={o.id}>
              <button className="ad-list-item" data-active={editing?.id === o.id} data-off={!o.active} onClick={() => open(o)}>
                <strong>{o.name}{!o.active && " (ปิดอยู่)"}</strong>
                <span className="ad-muted">
                  {o.durationMode === "fixed" ? minutes(o.durationMinutes) : `${minutes(o.minMinutes)}–${minutes(o.maxMinutes)}`} · {priceSummary(o)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {editing && <OfferingEditor key={editing.id ?? "new"} slug={slug} catalog={catalog} initial={editing} onSaved={onSaved} onClose={() => setEditing(null)} />}
    </div>
  );
}

function OfferingEditor({ slug, catalog, initial, onSaved, onClose }) {
  const [o, setO] = useState(initial);
  const save = useSave();
  const set = (patch) => setO((x) => ({ ...x, ...patch }));
  const kinds = o.requirements.map((r) => r.kind);
  const usable = catalog.resources.filter((r) => kinds.includes(r.kind));

  const setReq = (i, patch) => set({ requirements: o.requirements.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setPrice = (i, patch) => set({ prices: o.prices.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const toggleDay = (i, day) => {
    const p = o.prices[i];
    const days = p.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    setPrice(i, { daysOfWeek: next.length === 7 ? null : next });
  };

  async function submit(event) {
    event.preventDefault();
    const body = {
      ...o,
      durationMinutes: toInt(o.durationMinutes),
      minMinutes: toInt(o.minMinutes),
      maxMinutes: toInt(o.maxMinutes),
      stepMinutes: toInt(o.stepMinutes),
      bufferAfterMinutes: toInt(o.bufferAfterMinutes) ?? 0,
      maxPartySize: toInt(o.maxPartySize) ?? 1,
      sortOrder: toInt(o.sortOrder) ?? 0,
      requirements: o.requirements.map((r) => ({ ...r, unitsPerBooking: toInt(o.maxPartySize) > 1 ? r.unitsPerBooking : "one" })),
      resourceIds: o.resourceIds.filter((id) => usable.some((r) => r.id === id)),
      prices: o.prices.map((p) => ({ ...p, amount: p.amount === "" ? null : Number(p.amount), start: p.start || null, end: p.end || null }))
    };
    const ok = await save.run(() => (o.id ? api("PUT", shopPath(slug, `/offerings/${o.id}`), body) : api("POST", shopPath(slug, "/offerings"), body)));
    if (ok) onSaved();
  }

  async function remove() {
    if (!window.confirm(`ลบ “${o.name}”? ถ้ามีการจองแล้วจะปิดไว้แทนการลบ`)) return;
    const ok = await save.run(async () => {
      const result = await api("DELETE", shopPath(slug, `/offerings/${o.id}`));
      if (result.archived) window.alert("บริการนี้มีการจองแล้ว จึงปิดไว้แทนการลบ");
    });
    if (ok) onSaved();
  }

  return (
    <form className="ad-card" onSubmit={submit}>
      <div className="ad-row ad-between">
        <h2>{o.id ? "แก้บริการ" : "บริการใหม่"}</h2>
        <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
      </div>
      <Locked>
      <div className="ad-grid">
        <label className="ad-field">ชื่อบริการ<input required value={o.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="ad-field">หมวด (ไม่บังคับ)<input value={o.category ?? ""} onChange={(e) => set({ category: e.target.value })} /></label>
      </div>
      <label className="ad-field">รายละเอียด (ไม่บังคับ)<textarea rows={2} value={o.description ?? ""} onChange={(e) => set({ description: e.target.value })} /></label>
      <MediaEditor label="ภาพบริการ" value={o.media ?? []} onChange={(media) => set({ media })} />

      <div className="ad-field">
        ระยะเวลา
        <div className="ad-checks">
          <label><input type="radio" checked={o.durationMode === "fixed"} onChange={() => set({ durationMode: "fixed" })} />ตายตัว</label>
          <label><input type="radio" checked={o.durationMode === "customer_choice"} onChange={() => set({ durationMode: "customer_choice" })} />ลูกค้าเลือกเอง (เช่น เช่าสนามรายชั่วโมง)</label>
        </div>
      </div>
      {o.durationMode === "fixed" ? (
        <label className="ad-field ad-short">นาน (นาที)<input type="number" min={5} max={1440} required value={o.durationMinutes ?? ""} onChange={(e) => set({ durationMinutes: e.target.value })} /></label>
      ) : (
        <div className="ad-grid">
          <label className="ad-field">ต่ำสุด (นาที)<input type="number" min={5} required value={o.minMinutes ?? ""} onChange={(e) => set({ minMinutes: e.target.value })} /></label>
          <label className="ad-field">สูงสุด (นาที)<input type="number" min={5} required value={o.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: e.target.value })} /></label>
          <label className="ad-field">เพิ่มทีละ (นาที)<input type="number" min={5} required value={o.stepMinutes ?? ""} onChange={(e) => set({ stepMinutes: e.target.value })} /></label>
        </div>
      )}
      <div className="ad-grid">
        <label className="ad-field">พักหลังจบ (นาที)<input type="number" min={0} value={o.bufferAfterMinutes} onChange={(e) => set({ bufferAfterMinutes: e.target.value })} /></label>
        <label className="ad-field">จองได้สูงสุดกี่คนต่อครั้ง<input type="number" min={1} value={o.maxPartySize} onChange={(e) => set({ maxPartySize: e.target.value })} /></label>
        <label className="ad-field">ลำดับที่แสดง<input type="number" value={o.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} /></label>
      </div>

      <div className="ad-field">
        ต้องใช้อะไร
        {o.requirements.map((r, i) => (
          <div key={i} className="ad-row ad-wrap">
            <KindPicker value={r.kind} onChange={(kind) => setReq(i, { kind })} catalog={catalog} />
            <label className="ad-check"><input type="checkbox" checked={r.customerPicks} onChange={(e) => setReq(i, { customerPicks: e.target.checked })} />ลูกค้าเลือกเอง</label>
            {toInt(o.maxPartySize) > 1 && (
              <select value={r.unitsPerBooking} onChange={(e) => setReq(i, { unitsPerBooking: e.target.value })} aria-label="ใช้กี่ที่">
                <option value="one">ใช้ 1 ที่ต่อการจอง</option>
                <option value="party_size">ใช้ตามจำนวนคน</option>
              </select>
            )}
            <button type="button" className="ad-link" onClick={() => set({ requirements: o.requirements.filter((_, j) => j !== i) })}>ลบ</button>
          </div>
        ))}
        {o.requirements.length < 4 && (
          <button
            type="button"
            className="ad-link"
            onClick={() => set({ requirements: [...o.requirements, { kind: Object.keys(RESOURCE_KINDS).find((k) => !kinds.includes(k)), customerPicks: false, unitsPerBooking: "one" }] })}
          >
            + เพิ่ม
          </button>
        )}
      </div>

      {kinds.length > 0 && (
        <div className="ad-field">
          ใครหรืออะไรทำบริการนี้ได้
          {usable.length === 0 && <span className="ad-muted">ยังไม่มี{kinds.map(kindWord).join("/")} — เพิ่มที่แท็บ “ช่าง / สนาม”</span>}
          <div className="ad-checks">
            {usable.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={o.resourceIds.includes(r.id)}
                  onChange={(e) => set({ resourceIds: e.target.checked ? [...o.resourceIds, r.id] : o.resourceIds.filter((x) => x !== r.id) })}
                />
                {r.name}{!r.active && " (ปิดอยู่)"}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="ad-field">
        ราคา — ถ้าหลายแถวตรงกัน แถวที่ระบุวันหรือเวลาชนะ (คิดรายชั่วโมงข้ามช่วงได้ เช่น 16:00–18:00 = ชม.แรกราคากลางวัน + ชม.ที่สองราคาเย็น)
        {o.prices.map((p, i) => (
          <div key={i} className="ad-price">
            <input type="number" min={0} step="0.01" required placeholder="ราคา" value={p.amount} onChange={(e) => setPrice(i, { amount: e.target.value })} aria-label="ราคา" />
            <select value={p.unit} onChange={(e) => setPrice(i, { unit: e.target.value })} aria-label="หน่วย">
              {Object.entries(UNITS).map(([k, v]) => <option key={k} value={k}>บาท {v}</option>)}
            </select>
            <span className="ad-days" role="group" aria-label="วัน">
              {DAY_SHORT.map((d, day) => (
                <button key={day} type="button" data-on={!p.daysOfWeek || p.daysOfWeek.includes(day)} onClick={() => toggleDay(i, day)}>{d}</button>
              ))}
            </span>
            <span className="ad-inline">
              <input type="time" value={p.start ?? ""} onChange={(e) => setPrice(i, { start: e.target.value })} aria-label="ตั้งแต่" />–
              <input type="time" value={p.end ?? ""} onChange={(e) => setPrice(i, { end: e.target.value })} aria-label="ถึง" />
            </span>
            <button type="button" className="ad-link" onClick={() => set({ prices: o.prices.filter((_, j) => j !== i) })}>ลบ</button>
          </div>
        ))}
        <button type="button" className="ad-link" onClick={() => set({ prices: [...o.prices, { unit: o.prices[0]?.unit ?? "per_booking", amount: "", daysOfWeek: null, start: null, end: null, priority: null }] })}>
          + เพิ่มราคา (เช่น ช่วงเย็น / เสาร์อาทิตย์)
        </button>
      </div>

      <label className="ad-check"><input type="checkbox" checked={o.active} onChange={(e) => set({ active: e.target.checked })} />เปิดให้จอง</label>
      <Status save={save} />
      <div className="ad-row">
        <button className="ad-primary" disabled={save.busy}>บันทึก</button>
        {o.id && <button type="button" className="ad-danger" onClick={remove} disabled={save.busy}>ลบบริการ</button>}
      </div>
      </Locked>
    </form>
  );
}

// ---------- resources ----------

const NEW_KIND = "__new__";

/** The four built-in kinds, the shop's own ones, and "+ ตั้งชื่อชนิดใหม่…" to type another */
function KindPicker({ value, onChange, catalog }) {
  const [typing, setTyping] = useState(false);
  const known = [...new Set([...Object.keys(RESOURCE_KINDS), ...catalog.resources.map((r) => r.kind)])];
  if (typing) {
    return (
      <span className="ad-kind-new">
        <input autoFocus required maxLength={40} placeholder="เช่น เก้าอี้นวด" value={value} onChange={(e) => onChange(e.target.value)} aria-label="ชื่อชนิดใหม่" />
        <button type="button" className="ad-link" onClick={() => { setTyping(false); onChange(known[0]); }}>ยกเลิก</button>
      </span>
    );
  }
  const options = !value || known.includes(value) ? known : [...known, value];
  return (
    <select
      value={value}
      aria-label="ชนิด"
      onChange={(e) => {
        if (e.target.value !== NEW_KIND) return onChange(e.target.value);
        setTyping(true);
        onChange("");
      }}
    >
      {options.map((k) => <option key={k} value={k}>{RESOURCE_KINDS[k] ?? k}</option>)}
      <option value={NEW_KIND}>+ ตั้งชื่อชนิดใหม่…</option>
    </select>
  );
}

function emptyResource(catalog) {
  return {
    id: null,
    kind: catalog.shop.kind === "court" ? "court" : "staff",
    name: "",
    capacity: 1,
    sortOrder: catalog.resources.length + 1,
    active: true,
    schedule: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, isWorking: true, start: null, end: null, custom: false })),
    offeringIds: catalog.offerings.filter((o) => o.active).map((o) => o.id)
  };
}

function ResourcesTab({ slug, catalog, onSaved }) {
  const [editing, setEditing] = useState(null);
  const readOnly = useContext(ReadOnly);
  useEffect(() => setEditing((e) => (e?.id ? structuredClone(catalog.resources.find((r) => r.id === e.id) ?? null) : null)), [catalog]);

  return (
    <div className="ad-split">
      <section className="ad-card">
        <div className="ad-row ad-between">
          <h2>ช่าง / สนาม / ห้อง</h2>
          {!readOnly && <button className="ad-secondary" onClick={() => setEditing(emptyResource(catalog))}>+ เพิ่ม</button>}
        </div>
        <p className="ad-muted">สิ่งที่ถูกจองแล้วคนอื่นใช้ช่วงเวลาเดียวกันไม่ได้ ความจุมากกว่า 1 = รับหลายคนพร้อมกัน (เช่น คลาสโยคะ 12 ที่)</p>
        {catalog.resources.length === 0 && <p className="ad-muted">ยังไม่มี</p>}
        <ul className="ad-list">
          {catalog.resources.map((r) => (
            <li key={r.id}>
              <button className="ad-list-item" data-active={editing?.id === r.id} data-off={!r.active} onClick={() => setEditing(structuredClone(r))}>
                <strong>{r.name}{!r.active && " (ปิดอยู่)"}</strong>
                <span className="ad-muted">
                  {RESOURCE_KINDS[r.kind] ?? r.kind}{r.capacity > 1 ? ` · ${r.capacity} ที่` : ""} · ทำ {r.offeringIds.length} บริการ
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {editing && <ResourceEditor key={editing.id ?? "new"} slug={slug} catalog={catalog} initial={editing} onSaved={onSaved} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ResourceEditor({ slug, catalog, initial, onSaved, onClose }) {
  const [r, setR] = useState(initial);
  const save = useSave();
  const set = (patch) => setR((x) => ({ ...x, ...patch }));
  const setDay = (d, patch) => set({ schedule: r.schedule.map((s) => (s.dayOfWeek === d ? { ...s, ...patch } : s)) });
  const shopHours = catalog.hours;

  function dayMode(s) {
    return !s.custom ? "shop" : s.isWorking ? "custom" : "off";
  }
  function changeDayMode(d, mode) {
    const h = shopHours[d];
    if (mode === "shop") setDay(d, { custom: false, isWorking: true });
    if (mode === "off") setDay(d, { custom: true, isWorking: false });
    if (mode === "custom") setDay(d, { custom: true, isWorking: true, start: h.open, end: h.close });
  }

  async function submit(event) {
    event.preventDefault();
    const body = { ...r, capacity: toInt(r.capacity) ?? 1, sortOrder: toInt(r.sortOrder) ?? 0 };
    const ok = await save.run(() => (r.id ? api("PUT", shopPath(slug, `/resources/${r.id}`), body) : api("POST", shopPath(slug, "/resources"), body)));
    if (ok) onSaved();
  }

  async function remove() {
    if (!window.confirm(`ลบ “${r.name}”? ถ้ามีการจองแล้วจะปิดไว้แทนการลบ`)) return;
    const ok = await save.run(async () => {
      const result = await api("DELETE", shopPath(slug, `/resources/${r.id}`));
      if (result.archived) window.alert("มีการจองแล้ว จึงปิดไว้แทนการลบ");
    });
    if (ok) onSaved();
  }

  return (
    <div className="ad-stack">
      <form className="ad-card" onSubmit={submit}>
        <div className="ad-row ad-between">
          <h2>{r.id ? `แก้ ${initial.name}` : "เพิ่มใหม่"}</h2>
          <button type="button" className="ad-link" onClick={onClose}>ปิด</button>
        </div>
        <Locked>
        <div className="ad-grid">
          <label className="ad-field">ชื่อ<input required value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="ช่างแนน / สนาม 1" /></label>
          <label className="ad-field">
            ชนิด
            <KindPicker value={r.kind} onChange={(kind) => set({ kind })} catalog={catalog} />
          </label>
          <label className="ad-field">ความจุ (คนพร้อมกัน)<input type="number" min={1} value={r.capacity} onChange={(e) => set({ capacity: e.target.value })} /></label>
          <label className="ad-field">ลำดับที่แสดง<input type="number" value={r.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} /></label>
        </div>

        <div className="ad-field">
          วันและเวลาทำงาน
          <table className="ad-table">
            <tbody>
              {r.schedule.map((s) => (
                <tr key={s.dayOfWeek}>
                  <td>{DAYS[s.dayOfWeek]}</td>
                  <td>
                    <select value={dayMode(s)} onChange={(e) => changeDayMode(s.dayOfWeek, e.target.value)} aria-label={`วัน${DAYS[s.dayOfWeek]}`}>
                      <option value="shop">ตามเวลาร้าน{shopHours[s.dayOfWeek].isOpen ? ` (${shopHours[s.dayOfWeek].open}–${shopHours[s.dayOfWeek].close})` : " (ร้านปิด)"}</option>
                      <option value="custom">กำหนดเวลาเอง</option>
                      <option value="off">หยุด</option>
                    </select>
                  </td>
                  <td>
                    {dayMode(s) === "custom" && (
                      <span className="ad-inline">
                        <input type="time" required value={s.start ?? ""} onChange={(e) => setDay(s.dayOfWeek, { start: e.target.value })} aria-label="เริ่มงาน" />–
                        <input type="time" required value={s.end ?? ""} onChange={(e) => setDay(s.dayOfWeek, { end: e.target.value })} aria-label="เลิกงาน" />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ad-field">
          ทำบริการไหนได้บ้าง
          {catalog.offerings.length === 0 && <span className="ad-muted">ยังไม่มีบริการ</span>}
          <div className="ad-checks">
            {catalog.offerings.map((o) => (
              <label key={o.id}>
                <input
                  type="checkbox"
                  checked={r.offeringIds.includes(o.id)}
                  onChange={(e) => set({ offeringIds: e.target.checked ? [...r.offeringIds, o.id] : r.offeringIds.filter((x) => x !== o.id) })}
                />
                {o.name}{!o.active && " (ปิดอยู่)"}
              </label>
            ))}
          </div>
        </div>
        <label className="ad-check"><input type="checkbox" checked={r.active} onChange={(e) => set({ active: e.target.checked })} />เปิดรับจอง</label>
        <Status save={save} />
        <div className="ad-row">
          <button className="ad-primary" disabled={save.busy}>บันทึก</button>
          {r.id && <button type="button" className="ad-danger" onClick={remove} disabled={save.busy}>ลบ</button>}
        </div>
        </Locked>
      </form>
      {r.id && (
        <DaysOff
          title={`วันลา / หยุด ของ ${initial.name}`}
          items={catalog.timeOff.filter((t) => t.resourceId === r.id)}
          add={(body) => api("POST", shopPath(slug, "/time-off"), { ...body, resourceId: r.id })}
          remove={(id) => api("DELETE", shopPath(slug, `/time-off/${id}`))}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

// ---------- shop, hours and closures ----------

function DaysOff({ title, items, add, remove, onSaved }) {
  const [form, setForm] = useState({ date: today(), isFullDay: true, start: "12:00", end: "13:00", reason: "" });
  const save = useSave();
  return (
    <section className="ad-card">
      <h2>{title}</h2>
      <Locked>
      {items.length === 0 && <p className="ad-muted">ไม่มี</p>}
      <ul className="ad-list">
        {items.map((t) => (
          <li key={t.id} className="ad-row ad-between">
            <span>
              {new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${t.date}T00:00:00Z`))}
              {" · "}{t.isFullDay ? "ทั้งวัน" : `${t.start}–${t.end}`}{t.reason ? ` · ${t.reason}` : ""}
            </span>
            <button type="button" className="ad-link" onClick={async () => (await save.run(() => remove(t.id), "ลบแล้ว")) && onSaved()}>ลบ</button>
          </li>
        ))}
      </ul>
      <form
        className="ad-row ad-wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await save.run(() => add(form), "เพิ่มแล้ว")) onSaved();
        }}
      >
        <input type="date" required min={today()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="วันที่" />
        <select value={form.isFullDay ? "full" : "part"} onChange={(e) => setForm({ ...form, isFullDay: e.target.value === "full" })} aria-label="ช่วง">
          <option value="full">ทั้งวัน</option>
          <option value="part">บางช่วง</option>
        </select>
        {!form.isFullDay && (
          <span className="ad-inline">
            <input type="time" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} aria-label="ตั้งแต่" />–
            <input type="time" required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} aria-label="ถึง" />
          </span>
        )}
        <input placeholder="เหตุผล (ไม่บังคับ)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-label="เหตุผล" />
        <button className="ad-secondary" disabled={save.busy}>เพิ่ม</button>
      </form>
      <Status save={save} />
      </Locked>
    </section>
  );
}

function HoursTab({ slug, catalog, onSaved }) {
  const initial = useMemo(() => ({ name: catalog.shop.name, kind: catalog.shop.kind, media: catalog.shop.media ?? [], settings: catalog.settings, hours: catalog.hours }), [catalog]);
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const save = useSave();
  const setSetting = (key, value) => setForm((f) => ({ ...f, settings: { ...f.settings, [key]: value } }));
  const setDay = (d, patch) => setForm((f) => ({ ...f, hours: f.hours.map((h) => (h.dayOfWeek === d ? { ...h, ...patch } : h)) }));
  // one day's times on every day; days marked closed stay closed
  const copyHours = (from) => setForm((f) => ({ ...f, hours: f.hours.map((h) => ({ ...h, open: from.open, close: from.close })) }));

  async function submit(event) {
    event.preventDefault();
    const settings = Object.fromEntries(Object.entries(form.settings).map(([k, v]) => [k, typeof v === "boolean" ? v : toInt(v)]));
    if (await save.run(() => api("PUT", shopPath(slug), { ...form, settings }))) onSaved();
  }

  return (
    <div className="ad-split">
      <form className="ad-card" onSubmit={submit}>
        <Locked>
        <h2>ร้าน</h2>
        <div className="ad-grid">
          <label className="ad-field">ชื่อร้าน<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="ad-field">
            ประเภท
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {Object.entries(SHOP_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <MediaEditor label="ภาพร้าน" value={form.media} onChange={(media) => setForm((f) => ({ ...f, media }))} />
        <h2>เวลาทำการ</h2>
        <table className="ad-table">
          <tbody>
            {form.hours.map((h) => (
              <tr key={h.dayOfWeek}>
                <td>{DAYS[h.dayOfWeek]}</td>
                <td><label className="ad-check"><input type="checkbox" checked={h.isOpen} onChange={(e) => setDay(h.dayOfWeek, { isOpen: e.target.checked })} />เปิด</label></td>
                <td>
                  {h.isOpen && (
                    <span className="ad-inline">
                      <input type="time" required value={h.open} onChange={(e) => setDay(h.dayOfWeek, { open: e.target.value })} aria-label={`เปิดวัน${DAYS[h.dayOfWeek]}`} />–
                      <input type="time" required value={h.close} onChange={(e) => setDay(h.dayOfWeek, { close: e.target.value })} aria-label={`ปิดวัน${DAYS[h.dayOfWeek]}`} />
                    </span>
                  )}
                </td>
                <td>
                  {h.isOpen && (
                    <button type="button" className="ad-link ad-nowrap" onClick={() => copyHours(h)} title={`ใช้เวลา ${h.open}–${h.close} กับทุกวัน`}>
                      ใช้กับทุกวัน
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>กติกาการจอง</h2>
        <div className="ad-grid">
          <label className="ad-field">จองล่วงหน้าอย่างน้อย (นาที)<input type="number" min={0} required value={form.settings.minLeadMinutes} onChange={(e) => setSetting("minLeadMinutes", e.target.value)} /></label>
          <label className="ad-field">เวลาเริ่มทุก ๆ (นาที)<input type="number" min={5} required value={form.settings.slotIntervalMinutes} onChange={(e) => setSetting("slotIntervalMinutes", e.target.value)} /></label>
          <label className="ad-field">เปิดให้จองล่วงหน้า (วัน)<input type="number" min={1} max={365} required value={form.settings.maxAdvanceDays} onChange={(e) => setSetting("maxAdvanceDays", e.target.value)} /></label>
        </div>
        <h2>ลูกค้าเปลี่ยนการจองเอง</h2>
        <p className="ad-muted">หลังจอง ลูกค้าได้ลิงก์ของการจองนั้น ใช้ดู เลื่อน หรือยกเลิกเองได้ตามที่ร้านอนุญาต</p>
        <div className="ad-grid">
          <label className="ad-check"><input type="checkbox" checked={form.settings.customerCanReschedule} onChange={(e) => setSetting("customerCanReschedule", e.target.checked)} />ให้ลูกค้าเลื่อนนัดเอง</label>
          <label className="ad-check"><input type="checkbox" checked={form.settings.customerCanCancel} onChange={(e) => setSetting("customerCanCancel", e.target.checked)} />ให้ลูกค้ายกเลิกเอง</label>
          <label className="ad-field">
            ทำได้ถึงก่อนนัด (ชั่วโมง)
            <input type="number" min={0} max={720} required value={form.settings.customerChangeCutoffHours} onChange={(e) => setSetting("customerChangeCutoffHours", e.target.value)} />
          </label>
        </div>
        <Status save={save} />
        <button className="ad-primary" disabled={save.busy}>บันทึก</button>
        </Locked>
      </form>
      <DaysOff
        title="วันหยุดร้าน"
        items={catalog.closures}
        add={(body) => api("POST", shopPath(slug, "/closures"), body)}
        remove={(id) => api("DELETE", shopPath(slug, `/closures/${id}`))}
        onSaved={onSaved}
      />
    </div>
  );
}
