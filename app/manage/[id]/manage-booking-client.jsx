"use client";

import { useEffect, useState } from "react";
import { conflictMessage, formatDateTime, formatMoney } from "../../../src/ui/booking-flow-client.mjs";

function ManageBookingClient({ bookingId }) {
  const [booking, setBooking] = useState(null);
  const [phone, setPhone] = useState("");
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [date, setDate] = useState("2026-09-10");
  const [loading, setLoading] = useState({ booking: false, slots: false, action: false });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (booking?.service_id && booking?.staff_id) {
      loadSlots();
    }
  }, [booking?.service_id, booking?.staff_id, date]);

  async function loadBooking() {
    setLoading((current) => ({ ...current, booking: true }));
    setError("");
    try {
      const item = await fetchJson(`/api/bookings/${bookingId}`, { headers: { "x-booking-phone": phone } });
      setBooking(item);
      setDate(toInputDate(item.start_at));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading((current) => ({ ...current, booking: false }));
    }
  }

  async function loadSlots() {
    setLoading((current) => ({ ...current, slots: true }));
    setError("");
    const params = new URLSearchParams({
      service_id: booking.service_id,
      staff_id: booking.staff_id,
      date
    });
    try {
      const result = await fetchJson(`/api/availability?${params.toString()}`);
      setSlots(result.slots);
      setSelectedSlot(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading((current) => ({ ...current, slots: false }));
    }
  }

  async function reschedule() {
    setLoading((current) => ({ ...current, action: true }));
    setError("");
    setNotice("");
    try {
      await fetchJson(`/api/bookings/${bookingId}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-booking-phone": phone },
        body: JSON.stringify({
          staff_id: selectedSlot.staff_id,
          start_at: selectedSlot.start_at,
          reason: "customer reschedule"
        })
      });
      setNotice("เปลี่ยนเวลานัดสำเร็จ");
      await loadBooking();
    } catch (err) {
      setError(conflictMessage(err));
      await loadSlots();
    } finally {
      setLoading((current) => ({ ...current, action: false }));
    }
  }

  async function cancel() {
    setLoading((current) => ({ ...current, action: true }));
    setError("");
    setNotice("");
    try {
      await fetchJson(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-booking-phone": phone },
        body: JSON.stringify({ reason: "customer request", actor: "customer" })
      });
      setNotice("ยกเลิกนัดสำเร็จ");
      await loadBooking();
    } catch (err) {
      setError(err.code === "FORBIDDEN" ? "เลยช่วงเวลายกเลิกแล้ว กรุณาติดต่อร้าน" : err.message);
    } finally {
      setLoading((current) => ({ ...current, action: false }));
    }
  }

  return (
    <main className="app-shell">
      <Header />
      <section className="workspace">
        <div className="work-panel">
          <div className="panel-heading">
            <h1>รายละเอียดนัด</h1>
            <p>ดูสถานะ เปลี่ยนเวลา หรือยกเลิกนัด</p>
          </div>
          {loading.booking ? <div className="state">กำลังโหลด booking</div> : null}
          {error ? <div className="state error">{error}</div> : null}
          {notice ? <div className="state success">{notice}</div> : null}
          {!booking ? <form onSubmit={(event) => { event.preventDefault(); loadBooking(); }}>
            <label className="field"><span>เบอร์โทรที่ใช้จอง</span>
              <input type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={24} required />
            </label>
            <button className="primary-button" disabled={phone.replace(/\D/g, "").length < 9 || loading.booking}>ยืนยันข้อมูล</button>
          </form> : null}
          {booking ? (
            <>
              <BookingDetail booking={booking} />
              <div className="field-grid two">
                <label className="field">
                  <span>วันที่ต้องการเปลี่ยน</span>
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                </label>
              </div>
              {loading.slots ? <div className="state">กำลังตรวจเวลาว่าง</div> : null}
              {!loading.slots && slots.length === 0 ? <div className="state">ยังไม่มีเวลาว่างสำหรับวันนี้</div> : null}
              <div className="slot-grid">
                {slots.map((slot) => (
                  <button
                    className="slot-button"
                    data-selected={selectedSlot?.start_at === slot.start_at}
                    key={`${slot.staff_id}-${slot.start_at}`}
                    onClick={() => setSelectedSlot(slot)}
                  >
                    <span className="option-title">{formatDateTime(slot.start_at)}</span>
                    <span className="muted">จบ {formatDateTime(slot.end_at)}</span>
                  </button>
                ))}
              </div>
              <div className="actions">
                <button className="danger-button" onClick={cancel} disabled={loading.action || booking.status === "cancelled"}>
                  ยกเลิกนัด
                </button>
                <button className="primary-button" onClick={reschedule} disabled={!selectedSlot || loading.action}>
                  เปลี่ยนเวลา
                </button>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function BookingDetail({ booking }) {
  return (
    <dl className="summary-list">
      <div>
        <dt>Booking reference</dt>
        <dd>{booking.id}</dd>
      </div>
      <div>
        <dt>บริการ</dt>
        <dd>{booking.service?.name} · {booking.service?.duration_minutes} นาที · {formatMoney(booking.service?.price)}</dd>
      </div>
      <div>
        <dt>ช่าง</dt>
        <dd>{booking.staff?.name}</dd>
      </div>
      <div>
        <dt>เวลา</dt>
        <dd>{formatDateTime(booking.start_at)}</dd>
      </div>
      <div>
        <dt>สถานะ</dt>
        <dd><span className={`status ${booking.status}`}>{booking.status}</span></dd>
      </div>
    </dl>
  );
}

function Header() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <strong>Salon Booking OS</strong>
        <span>จัดการนัดหมาย</span>
      </a>
      <nav className="nav-links">
        <a href="/">จองคิว</a>
        <a href="/assistant">ผู้ช่วยนัดหมาย</a>
        <a href="/admin">Admin</a>
      </nav>
    </header>
  );
}

function toInputDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || "request failed");
    error.code = body.error?.code;
    throw error;
  }
  return body.data;
}

export default ManageBookingClient;
