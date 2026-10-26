"use client";

// The customer's own booking (/b/<slug>/manage/<token>), opened from the link shown after booking:
// see it, move it to another free time with the same stylist, or cancel it, as far as the shop's
// rules allow. The server checks the rules again on every change (src/v2/manage-booking.js).

import { useState } from "react";

const STATUS = {
  held: "รอชำระเงิน",
  pending: "รอร้านยืนยัน",
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

const longDate = (date) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
const money = (amount) => `${Number(amount).toLocaleString("th-TH")} บาท`;

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

  const { shop, booking } = view;
  const api = `/api/b/${shop.slug}/manage/${token}`;
  // formatted the same on the server and in the browser (no short weekday names, which differ)
  const deadline = `${new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(`${view.deadline.date}T00:00:00Z`))} ${view.deadline.time}`;

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

  const open = view.cancel.allowed || view.reschedule.allowed;
  const blocked = [view.cancel, view.reschedule].find((p) => !p.allowed && p.reason !== "NOT_CHANGEABLE");

  return (
    <main className="bk-shell" aria-busy={busy}>
      <header className="bk-header">
        <h1>{shop.name}</h1>
        <p className="bk-muted">การจองของ {booking.customerName}</p>
      </header>

      {notice && <p className="bk-notice" role="status">{notice}</p>}
      {error && <p className="bk-error" role="alert">{error}</p>}

      <section className="bk-card" data-testid="manage-booking">
        <div className="bk-row">
          <h2>{booking.offering.name}</h2>
          <span className="bk-status" data-status={booking.status}>{STATUS[booking.status] ?? booking.status}</span>
        </div>
        <dl className="bk-summary">
          <div>
            <dt>วัน</dt>
            <dd>{longDate(booking.date)}</dd>
          </div>
          <div>
            <dt>เวลา</dt>
            <dd>{booking.start}–{booking.end} น.</dd>
          </div>
          {booking.resources.length > 0 && (
            <div>
              <dt>{booking.resources[0].kind === "staff" ? "ช่าง" : "ที่"}</dt>
              <dd>{booking.resources.map((r) => r.name).join(", ")}</dd>
            </div>
          )}
          {booking.partySize > 1 && (
            <div>
              <dt>จำนวนคน</dt>
              <dd>{booking.partySize} คน</dd>
            </div>
          )}
          {booking.price > 0 && (
            <div>
              <dt>ราคา</dt>
              <dd>{money(booking.price)}</dd>
            </div>
          )}
        </dl>
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

      {mode === "reschedule" && (
        <section className="bk-card" data-step="reschedule">
          <div className="bk-row">
            <h2>เลือกวันใหม่</h2>
            <button type="button" className="bk-text-button" onClick={() => setMode(null)}>ปิด</button>
          </div>
          {!dates ? (
            <p className="bk-muted">กำลังดูวันที่ว่าง…</p>
          ) : (
            <div className="bk-options bk-options-date">
              {dates.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="bk-option"
                  data-testid="option-date"
                  data-value={o.value}
                  data-selected={pick.date === o.value}
                  disabled={busy || !o.available}
                  onClick={() => chooseDate(o.value)}
                >
                  <span className="bk-day-label">{new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "short" }).format(new Date(`${o.value}T00:00:00Z`))}</span>
                  <strong>{new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${o.value}T00:00:00Z`))}</strong>
                  {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                </button>
              ))}
            </div>
          )}
          {pick.date && (
            <>
              <h2>เลือกเวลาใหม่</h2>
              {!times ? (
                <p className="bk-muted">กำลังดูเวลาที่ว่าง…</p>
              ) : times.options.length === 0 ? (
                <p className="bk-muted">วันนี้ไม่มีเวลาว่างแล้ว ลองเลือกวันอื่น</p>
              ) : (
                <div className="bk-options bk-options-time">
                  {times.options.map((o) => {
                    const current = pick.date === booking.date && o.value === booking.start;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        className="bk-option"
                        data-testid="option-time"
                        data-value={o.value}
                        data-selected={pick.time === o.value}
                        disabled={busy || current}
                        onClick={() => setPick({ ...pick, time: o.value })}
                      >
                        <strong>{o.value}</strong>
                        {current && <small className="bk-reason">เวลาเดิม</small>}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <button type="button" className="bk-primary" disabled={busy || !pick.time} onClick={confirmReschedule}>
            {pick.time ? `ยืนยันเลื่อนเป็น ${pick.time} น.` : "เลือกวันและเวลาใหม่"}
          </button>
        </section>
      )}

      {mode === "cancel" && (
        <form className="bk-card" onSubmit={confirmCancel}>
          <h2>ยกเลิกการจองนี้?</h2>
          <label className="bk-field">
            <span>เหตุผล (ไม่บังคับ ร้านจะเห็นข้อความนี้)</span>
            <textarea rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="bk-actions">
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
  );
}
