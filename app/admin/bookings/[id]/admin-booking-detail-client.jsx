"use client";

import { useEffect, useState } from "react";
import { formatDateTime, formatMoney } from "../../../../src/ui/booking-flow-client.mjs";

const ACTIONS = [
  ["checked_in", "Check-in"],
  ["completed", "เสร็จสิ้น"],
  ["cancelled", "ยกเลิก"],
  ["no_show", "No-show"]
];

function AdminBookingDetailClient({ bookingId }) {
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState({ detail: true, action: false });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    loadBooking();
  }, [bookingId]);

  async function loadBooking() {
    setLoading((current) => ({ ...current, detail: true }));
    setError("");
    try {
      setBooking(await fetchJson(`/api/bookings/${bookingId}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading((current) => ({ ...current, detail: false }));
    }
  }

  async function updateStatus(status) {
    setLoading((current) => ({ ...current, action: true }));
    setError("");
    setNotice("");
    try {
      await fetchJson(`/api/bookings/${bookingId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason: "admin action", changed_by: "admin" })
      });
      setNotice("อัปเดตสถานะสำเร็จ");
      await loadBooking();
    } catch (err) {
      setError(err.message);
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
            <h1>Booking detail</h1>
            <p>ข้อมูลลูกค้า บริการ สถานะ และ action หลักของร้าน</p>
          </div>
          {loading.detail ? <div className="state">กำลังโหลด booking</div> : null}
          {error ? <div className="state error">{error}</div> : null}
          {notice ? <div className="state success">{notice}</div> : null}
          {booking ? (
            <>
              <dl className="summary-list">
                <div>
                  <dt>Booking reference</dt>
                  <dd>{booking.id}</dd>
                </div>
                <div>
                  <dt>ลูกค้า</dt>
                  <dd>{booking.customer?.name} · {booking.customer?.phone || "-"}</dd>
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
              <div className="actions">
                {ACTIONS.map(([status, label]) => (
                  <button
                    className={status === "cancelled" || status === "no_show" ? "danger-button" : "primary-button"}
                    key={status}
                    onClick={() => updateStatus(status)}
                    disabled={loading.action || booking.status === status}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="subsection">
                <div className="panel-heading">
                  <h2>History</h2>
                  <p>บันทึกการเปลี่ยนสถานะของ booking นี้</p>
                </div>
                <div className="list">
                  {(booking.history || []).map((item) => (
                    <div className="admin-row" key={item.id}>
                      <span className="row-title">{item.from_status || "-"} → {item.to_status}</span>
                      <span className="meta">
                        <span>{formatDateTime(item.changed_at)}</span>
                        <span>{item.reason || "-"}</span>
                        <span>{item.changed_by || "-"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function Header() {
  return (
    <header className="topbar">
      <a className="brand" href="/admin">
        <strong>Salon Booking OS</strong>
        <span>Booking detail</span>
      </a>
      <nav className="nav-links">
        <a href="/admin">Dashboard</a>
        <a href="/">จองคิว</a>
      </nav>
    </header>
  );
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || "request failed");
  }
  return body.data;
}

export default AdminBookingDetailClient;
