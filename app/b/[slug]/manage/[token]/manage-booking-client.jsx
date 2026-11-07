"use client";

// The customer's own booking (/b/<slug>/manage/<token>), opened from the link shown after booking:
// see it, move it to another free time with the same stylist, or cancel it, as far as the shop's
// rules allow. The server checks the rules again on every change (src/v2/manage-booking.js).
// Integrated with Stitch LINE OA Booking Interface (Screens 5, 6, 12).

import { CheckinQr } from "../../qr.jsx";
import { useState } from "react";
import CustomerFrame from "../../customer-frame.jsx";
import { DepositBox, DirectionsButton, DocumentsBox, ShopHeader, ResourceSummary, ResourceThumbnail } from "../../booking-presentation.jsx";
import { bookingCode } from "../../../../../src/v2/scan-codes.js";

const STATUS = {
  held: "รอโอนมัดจำ",
  pending: "รอร้านตรวจสลิป",
  confirmed: "ยืนยันแล้ว",
  checked_in: "มาถึงร้านแล้ว",
  completed: "ใช้บริการแล้ว",
  cancelled: "ยกเลิกแล้ว",
  no_show: "ไม่ได้มาตามนัด",
  expired: "หมดเวลารอชำระเงิน"
};

const REASON_TEXT = {
  FULLY_BOOKED: "เต็ม",
  BUSINESS_CLOSED: "ร้านปิด",
  STAFF_OFF: "ไม่อยู่",
  NO_WORKING_WINDOW: "ไม่มีคิว",
  NO_AVAILABLE_SLOTS: "ไม่มีคิว",
  PAST_WORKING_HOURS: "หมดเวลาจอง",
  OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิดจอง",
  NOT_OFFERED: "ไม่มีบริการนี้"
};

const SHORT_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const SHORT_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const longDate = (date) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
const money = (amount) => `${Number(amount).toLocaleString("th-TH")} บาท`;

function parseDateParts(dateStr) {
  if (!dateStr) return { day: "", month: "", weekday: "", year: "" };
  const d = new Date(`${dateStr}T00:00:00Z`);
  return {
    day: d.getUTCDate(),
    weekday: SHORT_DAYS[d.getUTCDay()],
    weekdayFull: new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long" }).format(d),
    month: SHORT_MONTHS[d.getUTCMonth()],
    monthFull: new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "long" }).format(d),
    year: d.getUTCFullYear() + 543
  };
}

function groupTimesByPeriod(options) {
  const morning = [];
  const afternoon = [];
  const evening = [];

  for (const o of options) {
    const hour = parseInt(o.value.slice(0, 2), 10);
    if (hour < 12) {
      morning.push(o);
    } else if (hour < 17) {
      afternoon.push(o);
    } else {
      evening.push(o);
    }
  }

  const groups = [];
  if (morning.length) groups.push({ id: "morning", label: "ช่วงเช้า (Morning)", icon: "morning", items: morning });
  if (afternoon.length) groups.push({ id: "afternoon", label: "ช่วงบ่าย (Afternoon)", icon: "afternoon", items: afternoon });
  if (evening.length) groups.push({ id: "evening", label: "ช่วงเย็น (Evening)", icon: "evening", items: evening });
  return groups.length > 0 ? groups : [{ id: "all", label: "เวลาทั้งหมด", icon: "all", items: options }];
}

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "ระบบขัดข้อง กรุณาลองใหม่");
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

export default function ManageBookingClient({ token, initial }) {
  const [view, setView] = useState(initial);
  const [mode, setMode] = useState(null); // "reschedule" | "cancel"
  const [dates, setDates] = useState(null);
  const [times, setTimes] = useState(null);
  const [pick, setPick] = useState({ date: null, time: null });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [copiedCoupon, setCopiedCoupon] = useState(false);

  const { shop, booking } = view;
  const api = `/api/b/${shop.slug}/manage/${token}`;
  const code = bookingCode(booking.id || booking.checkin || token);
  const dParts = parseDateParts(booking.date);
  const depositAmount = booking.deposit?.due || 0;

  // formatted the same on the server and in the browser (no short weekday names, which differ)
  const deadline = `${new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${view.deadline.date}T00:00:00Z`))} ${view.deadline.time}`;

  async function task(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function startReschedule() {
    setMode("reschedule");
    setNotice(null);
    setPick({ date: null, time: null });
    setTimes(null);
    task(async () => setDates((await post(`${api}/options`, { ask: "date" })).options));
  }

  function chooseDate(date) {
    setPick({ date, time: null });
    setTimes(null);
    task(async () => setTimes(await post(`${api}/options`, { ask: "time", date })));
  }

  function confirmReschedule() {
    task(async () => {
      try {
        setView(await post(`${api}/reschedule`, pick));
        setMode(null);
        setNotice(`เลื่อนนัดเป็น ${longDate(pick.date)} เวลา ${pick.time} น. แล้ว`);
      } catch (e) {
        if (e.status === 409) {
          setTimes(await post(`${api}/options`, { ask: "time", date: pick.date }));
          setPick({ ...pick, time: null });
        }
        throw e;
      }
    });
  }

  function confirmCancel(event) {
    event.preventDefault();
    task(async () => {
      setView(await post(`${api}/cancel`, { reason }));
      setMode(null);
      setNotice("ยกเลิกการจองแล้ว");
    });
  }

  async function copyCoupon(promoCode) {
    try {
      await navigator.clipboard.writeText(promoCode);
      setCopiedCoupon(true);
      setTimeout(() => setCopiedCoupon(false), 2000);
    } catch {
      setCopiedCoupon(false);
    }
  }

  const open = view.cancel.allowed || view.reschedule.allowed;
  const blocked = [view.cancel, view.reschedule].find((p) => !p.allowed && p.reason !== "NOT_CHANGEABLE");
  const timeGroups = times?.options ? groupTimesByPeriod(times.options) : [];

  // ==========================================
  // VIEW: CANCELLATION SUCCESS (Stitch Screen 12)
  // ==========================================
  if (booking.status === "cancelled") {
    return (
      <CustomerFrame>
        <main className="bk-shell" aria-busy={busy}>
          <ShopHeader shop={shop} subtitle={`การจองของ ${booking.customerName}`} />

          {notice && <p className="bk-notice" role="status">{notice}</p>}
          {error && <p className="bk-error" role="alert">{error}</p>}

          <section className="bk-card bk-cancel-success" data-testid="manage-booking">
            <div className="bk-cancel-hero">
              <div className="bk-cancel-hero-icon" aria-hidden="true">
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                <span className="bk-cancel-mini-tag">✕</span>
              </div>
              <span className="bk-ref-tag">REF: #CN-{code}</span>
              <h1>ยกเลิกการจองสำเร็จ</h1>
              <p className="bk-muted">
                ระบบได้ทำการยกเลิกคิวเรียบร้อยแล้ว{depositAmount > 0 ? " และส่งเรื่องประสานงานคืนเงินมัดจำ" : ""}
              </p>
              <div className="bk-time-stamp">
                <span>{longDate(booking.date)}</span>
              </div>
            </div>

            {/* Refund Tracking Stepper Card */}
            {depositAmount > 0 && (
              <div className="bk-refund-card">
                <div className="bk-row">
                  <div className="bk-refund-head">
                    <span>สถานะการคืนเงินมัดจำ</span>
                  </div>
                  <span className="bk-status bk-status-progress">กำลังดำเนินการ</span>
                </div>
                <div className="bk-refund-total">
                  <div>
                    <span>ยอดเงินคืนมัดจำสุทธิ</span>
                    <small className="bk-muted" style={{ display: "block" }}>คืนเต็มจำนวน 100% ตามเงื่อนไข</small>
                  </div>
                  <strong>{money(depositAmount)}</strong>
                </div>
                <div className="bk-stepper">
                  <div className="bk-stepper-item" data-done="true">
                    <span className="bk-stepper-bullet">✓</span>
                    <div className="bk-stepper-text">
                      <strong>ยื่นขอยกเลิกสำเร็จ</strong>
                      <span>ส่งคำร้องเข้าระบบอัตโนมัติเรียบร้อย</span>
                    </div>
                  </div>
                  <div className="bk-stepper-item" data-active="true">
                    <span className="bk-stepper-bullet">2</span>
                    <div className="bk-stepper-text">
                      <strong>ส่งคำสั่งคืนเงินเข้าผู้ให้บริการ / ร้านค้า</strong>
                      <span>กำลังประสานงานโอนคืนภายใน 1-3 วันทำการ</span>
                    </div>
                  </div>
                  <div className="bk-stepper-item">
                    <span className="bk-stepper-bullet">3</span>
                    <div className="bk-stepper-text">
                      <strong>เงินเข้าบัญชี / วอลเล็ท</strong>
                      <span>ได้รับยอดเงินคืนเรียบร้อย</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Cancelled Booking Summary Card */}
            <div className="bk-original-box">
              <div className="bk-original-head">
                <span>รายละเอียดนัดหมายเดิม</span>
                <span className="bk-status bk-status-danger" data-status="cancelled">ยกเลิกแล้ว</span>
              </div>
              <div className="bk-original-main">
                <div className="bk-date-tile-alt bk-strikethrough">
                  <small>{dParts.month}</small>
                  <strong><s>{dParts.day}</s></strong>
                </div>
                <div className="bk-original-info bk-strikethrough">
                  <strong><s>{booking.offering.name}</s></strong>
                  <span><s>{longDate(booking.date)} ({booking.start}–{booking.end} น.)</s></span>
                </div>
              </div>
              <dl className="bk-summary" style={{ margin: 0, opacity: 0.85 }}>
                {booking.resources.length > 0 && (
                  <div>
                    <dt>{booking.resources[0].kind === "staff" ? "ช่าง" : "ที่"}</dt>
                    <dd><s><ResourceSummary resources={booking.resources} /></s></dd>
                  </div>
                )}
                {booking.price > 0 && (
                  <div>
                    <dt>ยอดบริการ</dt>
                    <dd><s>{money(booking.price)}</s></dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Retention Offer Card */}
            <div className="bk-retention-card">
              <div className="bk-retention-head">
                <span>🎁 เราหวังว่าจะได้ดูแลคุณใหม่นะ!</span>
              </div>
              <p>มอบคูปองพิเศษแทนคำขอบคุณที่แจ้งล่วงหน้า นำไปใช้รับบริการครั้งถัดไปได้ทันที</p>
              <div className="bk-coupon-box">
                <div className="bk-coupon-info">
                  <span className="bk-coupon-label">คูปองส่วนลด 10%</span>
                  <strong className="bk-coupon-code">COMEBACK10</strong>
                </div>
                <button type="button" className="bk-copy-btn" onClick={() => copyCoupon("COMEBACK10")}>
                  {copiedCoupon ? "คัดลอกแล้ว!" : "คัดลอก"}
                </button>
              </div>
            </div>

            <a className="bk-primary bk-center" href={`/b/${shop.slug}`} style={{ textDecoration: "none", width: "100%", justifyContent: "center" }}>
              จองบริการใหม่อีกครั้ง
            </a>

            <div className="bk-line-badge bk-center" style={{ width: "100%", justifyContent: "center" }}>
              <span className="bk-line-dot" />
              <span>ส่งหลักฐานการยกเลิกเข้า LINE Chat คุณแล้ว</span>
            </div>
          </section>

          <a className="bk-powered" href="/" target="_blank" rel="noreferrer">
            จองผ่าน <img src="/brand/kiwmee-logo.svg" alt="kiwmee" />
          </a>
        </main>
      </CustomerFrame>
    );
  }

  return (
    <CustomerFrame>
      <main className="bk-shell" aria-busy={busy}>
        <ShopHeader shop={shop} subtitle={`การจองของ ${booking.customerName}`} />

        {notice && <p className="bk-notice" role="status">{notice}</p>}
        {error && <p className="bk-error" role="alert">{error}</p>}

        {booking.deposit?.paymentInfo && ["held", "pending"].includes(booking.status) && (
          <DepositBox
            deposit={booking.deposit}
            status={booking.status}
            deadline={booking.holdExpiresAt
              ? `${new Intl.DateTimeFormat("th-TH", { timeZone: shop.timezone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(booking.holdExpiresAt))} น.`
              : null}
            uploadUrl={`${api}/slip`}
            onUploaded={(next) => {
              setView(next);
              setNotice("ส่งสลิปแล้ว ร้านจะยืนยันคิวเมื่อตรวจยอด");
            }}
          />
        )}

        {view.documents && (
          <DocumentsBox
            documents={view.documents}
            shopName={shop.name}
            uploadUrl={`${api}/document`}
            onUploaded={(next) => {
              setView(next);
              setNotice("ส่งเอกสารแล้ว ร้านจะตรวจก่อนส่งมอบของ");
            }}
          />
        )}

        {/* DEFAULT MANAGE BOOKING TICKET */}
        <section className="bk-card bk-pass-card" data-testid="manage-booking">
          <div className="bk-pass-header">
            <div className="bk-pass-brand">
              <span className="bk-pass-badge">KIWMEE PASS</span>
              <strong className="bk-pass-code">#{code}</strong>
            </div>
            <span className="bk-status" data-status={booking.status}>
              {STATUS[booking.status] ?? booking.status}
            </span>
          </div>

          <div className="bk-step-head">
            <h2>{booking.offering.name}</h2>
          </div>

          <div className="bk-when">
            <span className="bk-date-tile" aria-hidden="true">
              <small>{dParts.month}</small>
              <strong>{dParts.day}</strong>
            </span>
            <div>
              <strong>{longDate(booking.date)}</strong>
              <span>
                {booking.endDate && booking.endDate !== booking.date
                  ? `รับ ${booking.start} น. · คืน ${longDate(booking.endDate)} ${booking.end} น.`
                  : `${booking.start}–${booking.end} น.`}
              </span>
            </div>
          </div>

          <dl className="bk-summary">
            {booking.resources.length > 0 && (
              <div>
                <dt>{booking.resources[0].kind === "staff" ? "ช่าง" : "ที่"}</dt>
                <dd><ResourceSummary resources={booking.resources} /></dd>
              </div>
            )}
            {booking.partySize > 1 && (
              <div>
                <dt>จำนวนคน</dt>
                <dd>{booking.partySize} คน</dd>
              </div>
            )}
            {booking.addons?.length > 0 && (
              <div>
                <dt>เพิ่มเติม</dt>
                <dd>{booking.addons.map((x) => `${x.name}${x.quantity > 1 ? ` ×${x.quantity}` : ""}`).join(", ")}</dd>
              </div>
            )}
            {booking.price > 0 && (
              <div>
                <dt>ราคา</dt>
                <dd>{money(booking.price)}</dd>
              </div>
            )}
            {view.points && (
              <div>
                <dt>ใช้คะแนน</dt>
                <dd>
                  {view.points.name} · {view.points.points} คะแนน<br />
                  <small className="bk-muted">ลด {money(view.points.discountBaht)} ตอนจ่ายที่ร้าน · ยกเลิกแล้วคะแนนคืน</small>
                </dd>
              </div>
            )}
          </dl>

          {booking.checkin && (
            <div className="bk-done-qr">
              <CheckinQr slug={shop.slug} id={booking.checkin} open={true} />
            </div>
          )}
          {!booking.checkin && ["held", "pending"].includes(booking.status) && <p className="bk-qr-wait">QR เช็กอินจะแสดงเมื่อร้านยืนยันมัดจำแล้ว</p>}

          {!["cancelled", "no_show", "expired", "completed"].includes(booking.status) && (
            <DirectionsButton href={shop.directions} />
          )}

          {open && (
            <p className="bk-muted">
              {view.cancel.allowed && view.reschedule.allowed ? "เลื่อนหรือยกเลิก" : view.cancel.allowed ? "ยกเลิก" : "เลื่อนนัด"}เองได้ถึง {deadline} น.
              {view.cutoffHours > 0 ? ` (${view.cutoffHours} ชม. ก่อนนัด)` : ""}
            </p>
          )}
          {blocked && <p className="bk-muted">{blocked.message}</p>}

          {open && !mode && (
            <div className="bk-actions">
              {view.reschedule.allowed && (
                <button type="button" className="bk-primary" onClick={startReschedule} disabled={busy}>
                  เลื่อนนัด
                </button>
              )}
              {view.cancel.allowed && (
                <button type="button" className="bk-secondary" onClick={() => { setMode("cancel"); setNotice(null); }} disabled={busy}>
                  ยกเลิกการจอง
                </button>
              )}
            </div>
          )}
        </section>

        {/* ==========================================
            VIEW: RESCHEDULE FLOW (Stitch Screen 5)
            ========================================== */}
        {mode === "reschedule" && (
          <section className="bk-card" data-step="reschedule">
            <div className="bk-row">
              <span className="bk-ref-tag">LINE Reschedule · #{code}</span>
              <button type="button" className="bk-text-button" onClick={() => setMode(null)}>ปิด</button>
            </div>

            <div className="bk-step-head">
              <h2>เลื่อนนัดหมาย</h2>
              <p className="bk-muted">เลือกวันเวลาที่สะดวกใหม่ ระบบจะคำนวณช่วงเวลาต่อเนื่องให้อัตโนมัติ</p>
            </div>

            {/* Original Appointment Card */}
            <div className="bk-original-box">
              <div className="bk-original-head">
                <span>นัดหมายเดิม (Original)</span>
                <span className="bk-duration-tag">{booking.start}–{booking.end} น.</span>
              </div>
              <div className="bk-original-main">
                <div className="bk-date-tile-alt">
                  <small>{dParts.weekday}</small>
                  <strong>{dParts.day}</strong>
                </div>
                <div className="bk-original-info">
                  <strong>{booking.offering.name}</strong>
                  <span>
                    {booking.resources.length > 0 && `${booking.resources[0].name} · `}
                    {longDate(booking.date)}
                  </span>
                </div>
                {booking.price > 0 && (
                  <div style={{ textAlign: "right", flex: "none" }}>
                    <small className="bk-muted" style={{ display: "block", fontSize: ".75rem" }}>ยอดบริการ</small>
                    <strong style={{ color: "var(--ink)", fontSize: ".92rem" }}>{money(booking.price)}</strong>
                  </div>
                )}
              </div>
              <div className="bk-policy-box" style={{ background: "var(--mint-tint)", borderColor: "rgba(61,220,151,.35)" }}>
                <span className="bk-policy-icon">✓</span>
                <p style={{ color: "var(--mint-deep)" }}>
                  <strong>เลื่อนฟรี:</strong> นัดหมายล่วงหน้าเกิน {view.cutoffHours} ชม. ไม่มีค่าธรรมเนียม และคงสิทธิ์มัดจำเดิม
                </p>
              </div>
            </div>

            {/* Step 1: Stylist / Resource indicator */}
            <div className="bk-step-head" style={{ marginTop: 6 }}>
              <div className="bk-row">
                <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>1. ผู้ให้บริการ (Stylist / Resource)</h3>
                <span className="bk-duration-tag">คิวต่อเนื่อง</span>
              </div>
              <div className="bk-original-box" style={{ padding: "10px 14px", background: "var(--bg)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {booking.resources.length > 0 ? (
                      <ResourceThumbnail resource={booking.resources[0]} />
                    ) : (
                      <span className="bk-avatar">✱</span>
                    )}
                    <div>
                      <strong style={{ display: "block", fontSize: ".92rem" }}>
                        {booking.resources[0]?.name || "ช่างเดิม"}
                      </strong>
                      <small className="bk-muted">ช่างเดิมจากการจอง</small>
                    </div>
                  </div>
                  <span className="bk-time-badge bk-time-free">ช่างเดิม ✓</span>
                </div>
              </div>
            </div>

            {/* Step 2: Date Selector */}
            <div className="bk-step-head" style={{ marginTop: 6 }}>
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>2. เลือกวันใหม่ (Select Date)</h3>
            </div>
            {!dates ? (
              <p className="bk-muted">กำลังดูวันที่ว่าง…</p>
            ) : (
              <div className="bk-options bk-options-date">
                {dates.map((o) => {
                  const d = new Date(`${o.value}T00:00:00Z`);
                  const weekday = SHORT_DAYS[d.getUTCDay()];
                  const dayNum = d.getUTCDate();
                  const monthShort = SHORT_MONTHS[d.getUTCMonth()];
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className="bk-option"
                      data-testid="option-date"
                      data-value={o.value}
                      data-selected={pick.date === o.value}
                      aria-pressed={pick.date === o.value}
                      disabled={busy || !o.available}
                      data-unavailable={!o.available || undefined}
                      onClick={() => chooseDate(o.value)}
                    >
                      <span className="bk-day-label">{weekday}</span>
                      <strong>{dayNum}</strong>
                      <span className="bk-day-month">{monthShort}</span>
                      <span className="bk-dot-indicator" aria-hidden="true" />
                      {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Step 3: Time Slot Selector */}
            {pick.date && (
              <>
                <div className="bk-step-head" style={{ marginTop: 6 }}>
                  <div className="bk-row">
                    <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>3. เลือกเวลาใหม่</h3>
                    <div style={{ display: "flex", gap: 10, fontSize: ".76rem", color: "var(--muted)" }}>
                      <span><i className="bk-dot-indicator" style={{ display: "inline-block", marginRight: 4 }} /> ว่าง</span>
                    </div>
                  </div>
                </div>

                {!times ? (
                  <p className="bk-muted">กำลังดูเวลาที่ว่าง…</p>
                ) : times.options.length === 0 ? (
                  <p className="bk-muted">วันนี้ไม่มีเวลาว่างแล้ว ลองเลือกวันอื่น</p>
                ) : (
                  timeGroups.map((group) => (
                    <div key={group.id} className="bk-time-group">
                      <div className="bk-time-group-head">
                        {group.icon === "morning" ? "☀️" : group.icon === "afternoon" ? "🌤️" : "🌙"}
                        <span>{group.label}</span>
                      </div>
                      <div className="bk-options bk-options-time">
                        {group.items.map((o) => {
                          const current = pick.date === booking.date && o.value === booking.start;
                          const isPicked = pick.time === o.value;
                          return (
                            <button
                              key={o.value}
                              type="button"
                              className="bk-option"
                              data-testid="option-time"
                              data-value={o.value}
                              data-selected={isPicked}
                              aria-pressed={isPicked}
                              disabled={busy || current}
                              data-unavailable={current || undefined}
                              onClick={() => setPick({ ...pick, time: o.value })}
                            >
                              <strong>{o.value}</strong>
                              {current ? (
                                <small className="bk-reason">เวลาเดิม</small>
                              ) : isPicked ? (
                                <span className="bk-time-badge bk-time-picked">เลือกอยู่ ✓</span>
                              ) : (
                                <span className="bk-time-badge bk-time-free">ว่าง</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {/* Summary Comparison Card (Bento Style) */}
            {pick.date && (
              <div className="bk-bento-comparison">
                <div className="bk-bento-head">
                  <h4>สรุปการเปลี่ยนแปลง</h4>
                  <span className="bk-time-badge bk-time-free">ไม่มีค่าใช้จ่ายเพิ่ม</span>
                </div>
                <div className="bk-comparison-grid">
                  <div className="bk-comparison-col" data-old="true">
                    <label>จากเดิม (Original)</label>
                    <strong>{longDate(booking.date)}</strong>
                    <span>{booking.start}–{booking.end} น.</span>
                  </div>
                  <div className="bk-comparison-arrow">→</div>
                  <div className="bk-comparison-col" data-new="true">
                    <label>เปลี่ยนเป็น (New)</label>
                    <strong>{longDate(pick.date)}</strong>
                    <span>{pick.time ? `${pick.time} น.` : "โปรดเลือกเวลา"}</span>
                  </div>
                </div>
                <div className="bk-bento-details">
                  <div className="bk-bento-row">
                    <span>ช่างผู้ให้บริการ:</span>
                    <strong>{booking.resources[0]?.name || "ช่างเดิม"}</strong>
                  </div>
                  <div className="bk-bento-row">
                    <span>รายการบริการ:</span>
                    <strong>{booking.offering.name}</strong>
                  </div>
                  <div className="bk-bento-row">
                    <span>ค่าธรรมเนียมการเลื่อน:</span>
                    <strong style={{ color: "var(--mint-deep)" }}>฿0 (ฟรี)</strong>
                  </div>
                </div>
              </div>
            )}

            {/* Quick Reschedule Reasons */}
            <div style={{ marginTop: 4 }}>
              <span style={{ fontSize: ".84rem", fontWeight: 600, color: "var(--ink)" }}>เหตุผลในการเลื่อน (ไม่บังคับ)</span>
              <div className="bk-reason-chips">
                {["ติดภารกิจด่วน", "เปลี่ยนวันเดินทาง", "จองเวลาผิด", "อื่นๆ"].map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="bk-reason-chip"
                    data-active={reason === r}
                    onClick={() => setReason(reason === r ? "" : r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="bk-actions" style={{ marginTop: 10 }}>
              <button type="button" className="bk-primary" disabled={busy || !pick.time} onClick={confirmReschedule}>
                {pick.time ? `ยืนยันเลื่อนเป็น ${pick.time} น.` : "เลือกวันและเวลาใหม่"}
              </button>
              <button type="button" className="bk-secondary" onClick={() => setMode(null)} disabled={busy}>
                ยกเลิกการเลือก
              </button>
            </div>
          </section>
        )}

        {/* ==========================================
            VIEW: CANCEL FLOW (Stitch Screen 6)
            ========================================== */}
        {mode === "cancel" && (
          <form className="bk-card" onSubmit={confirmCancel}>
            <div className="bk-row">
              <span className="bk-status bk-status-danger">ยกเลิกนัดหมาย</span>
              <span className="bk-ref-badge">#{code}</span>
            </div>

            <div className="bk-step-head">
              <h2>ระบุเหตุผลและยืนยันการยกเลิก</h2>
              <p className="bk-muted">โปรดตรวจสอบรายละเอียดการคืนเงินมัดจำก่อนยืนยันสิทธิ์</p>
            </div>

            {/* Retention Hero Banner (Stitch Screen 6) */}
            {view.reschedule.allowed && (
              <div className="bk-retention-box">
                <div className="bk-retention-content">
                  <span className="bk-retention-icon" aria-hidden="true">📅</span>
                  <div className="bk-retention-text">
                    <strong>ไม่อยากเสียคิวใช่ไหม?</strong>
                    <span>เลื่อนเวลาได้ฟรี 1 ครั้ง ไม่เสียค่าธรรมเนียม</span>
                  </div>
                </div>
                <button type="button" className="bk-retention-btn" onClick={startReschedule} disabled={busy}>
                  <span>เลื่อนนัด</span>
                  <span>→</span>
                </button>
              </div>
            )}

            {/* Original Booking Summary Card */}
            <div className="bk-original-box">
              <div className="bk-original-head">
                <span>นัดหมายที่ต้องการยกเลิก</span>
                <span className="bk-duration-tag">{booking.start}–{booking.end} น.</span>
              </div>
              <div className="bk-original-main">
                <div className="bk-date-tile-alt">
                  <small>{dParts.weekday}</small>
                  <strong>{dParts.day}</strong>
                </div>
                <div className="bk-original-info">
                  <strong>{booking.offering.name}</strong>
                  <span>
                    {booking.resources.length > 0 && `${booking.resources[0].name} · `}
                    {longDate(booking.date)}
                  </span>
                </div>
                {booking.price > 0 && (
                  <div style={{ textAlign: "right", flex: "none" }}>
                    <small className="bk-muted" style={{ display: "block", fontSize: ".75rem" }}>ยอดบริการ</small>
                    <strong style={{ color: "var(--ink)", fontSize: ".92rem" }}>{money(booking.price)}</strong>
                  </div>
                )}
              </div>
            </div>

            {/* Deposit & Refund Calculation Card */}
            <div className="bk-refund-card">
              <div className="bk-refund-head">
                <span>💰 สรุปยอดเงินมัดจำที่จะคืน</span>
              </div>
              <div className="bk-policy-box" style={{ background: "var(--mint-tint)", borderColor: "rgba(61,220,151,.35)" }}>
                <span className="bk-policy-icon">✓</span>
                <p style={{ color: "var(--mint-deep)" }}>
                  <strong>ยกเลิกล่วงหน้ามากกว่า {view.cutoffHours} ชั่วโมง:</strong> คืนเงินมัดจำเต็มจำนวน 100% ตามเงื่อนไขร้าน
                </p>
              </div>
              <div className="bk-refund-math">
                <div className="bk-refund-row">
                  <span>ยอดเงินมัดจำที่ชำระล่วงหน้า</span>
                  <strong>{money(depositAmount)}</strong>
                </div>
                <div className="bk-refund-row">
                  <span>ค่าธรรมเนียมการยกเลิก</span>
                  <strong style={{ color: "var(--mint-deep)" }}>฿0 (ฟรี)</strong>
                </div>
              </div>
              <div className="bk-refund-total">
                <div>
                  <span>ยอดเงินที่จะได้รับคืนสุทธิ</span>
                  <small className="bk-muted" style={{ display: "block" }}>โอนคืนอัตโนมัติภายใน 1-3 วันทำการ</small>
                </div>
                <strong>{money(depositAmount)}</strong>
              </div>
            </div>

            {/* Reasons for Cancellation */}
            <div>
              <span style={{ fontSize: ".92rem", fontWeight: 600, color: "var(--ink)" }}>เหตุผลในการยกเลิก</span>
              <p className="bk-muted" style={{ marginTop: 2, marginBottom: 8 }}>คำตอบของท่านช่วยให้เราพัฒนาบริการให้ดียิ่งขึ้น</p>
              <div className="bk-reason-chips">
                {[
                  "ติดภารกิจด่วนกะทันหัน",
                  "ต้องการเปลี่ยนเป็นบริการอื่น",
                  "ปัญหาสุขภาพ / ไม่สบาย",
                  "การเดินทางไม่สะดวก / สภาพจราจร",
                  "จองวันหรือเวลาผิด",
                  "เหตุผลอื่นๆ"
                ].map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="bk-reason-chip"
                    data-active={reason === r}
                    onClick={() => setReason(reason === r ? "" : r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <label className="bk-field" style={{ marginTop: 6 }}>
              <span>เหตุผล (ไม่บังคับ ร้านจะเห็นข้อความนี้)</span>
              <textarea
                rows={2}
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="ระบุรายละเอียดเพิ่มเติม (ถ้ามี)"
              />
            </label>

            <div className="bk-line-badge bk-center" style={{ width: "100%", justifyContent: "center" }}>
              <span className="bk-line-dot" />
              <span>ส่งหลักฐานการยกเลิกไปที่ LINE Chat & SMS</span>
            </div>

            <div className="bk-actions" style={{ marginTop: 8 }}>
              <button type="submit" className="bk-danger" disabled={busy}>ยืนยันยกเลิก</button>
              <button type="button" className="bk-secondary" onClick={() => setMode(null)} disabled={busy}>ไม่ยกเลิก</button>
            </div>
          </form>
        )}

        <a className="bk-text-button bk-center" href={`/b/${shop.slug}`}>จองคิวใหม่ที่ {shop.name}</a>
        <a className="bk-powered" href="/" target="_blank" rel="noreferrer">
          จองผ่าน <img src="/brand/kiwmee-logo.svg" alt="kiwmee" />
        </a>
      </main>
    </CustomerFrame>
  );
}
