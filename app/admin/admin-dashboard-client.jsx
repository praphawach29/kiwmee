"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTime, formatMoney } from "../../src/ui/booking-flow-client.mjs";

function AdminDashboardClient() {
  const [date, setDate] = useState(todayInBangkok());
  const [bookings, setBookings] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const stats = useMemo(() => buildStats(bookings), [bookings]);

  useEffect(() => {
    loadBookings();
    loadHandoffs();
  }, [date]);

  async function loadHandoffs() {
    try { setHandoffs((await fetchJson("/api/admin/handoffs")).handoffs); }
    catch (err) { setError(err.message); }
  }

  async function updateHandoff(id, status) {
    try {
      await fetchJson(`/api/admin/handoffs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      await loadHandoffs();
    } catch (err) { setError(err.message); }
  }

  async function loadBookings() {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson(`/api/admin/bookings?date=${date}`);
      setBookings(result.bookings);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <Header />
      <section className="workspace admin-layout">
        <div className="work-panel">
          <div className="panel-heading">
            <h1>Admin Dashboard</h1>
            <p>ตารางนัดรายวันและสถานะสำคัญของร้าน</p>
          </div>
          <div className="admin-toolbar">
            <label className="field">
              <span>วันที่</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <button className="ghost-button" onClick={loadBookings}>รีเฟรช</button>
          </div>
          <div className="stat-line">
            <span>ทั้งหมด {bookings.length}</span>
            <span>วันนี้ {stats.today}</span>
            <span>เสร็จแล้ว {stats.completed}</span>
            <span>ยกเลิก {stats.cancelled}</span>
            <span>No-show {stats.no_show}</span>
          </div>
        </div>

        <div className="work-panel">
          <div className="panel-heading"><h2>คำขอให้พนักงานรับช่วง</h2><p>รายการล่าสุดจากผู้ช่วยนัดหมาย</p></div>
          {handoffs.length === 0 ? <div className="state">ยังไม่มีคำขอส่งต่อ</div> : null}
          <div className="list">
            {handoffs.map((item) => <div className="handoff-row" key={item.id}>
              <div><strong>{handoffReason(item.reason)}</strong><span>{item.customer_channel} · {new Date(item.created_at).toLocaleString("th-TH")}</span></div>
              <span className={`status ${item.status}`}>{item.status}</span>
              <div className="handoff-actions">
                {item.status === "pending" && <button className="ghost-button" onClick={() => updateHandoff(item.id, "accepted")}>รับเรื่อง</button>}
                {item.status !== "resolved" && <button className="primary-button" onClick={() => updateHandoff(item.id, "resolved")}>ปิดเรื่อง</button>}
              </div>
            </div>)}
          </div>
        </div>

        <div className="work-panel">
          <div className="panel-heading">
            <h2>Daily booking list</h2>
            <p>รายการนัดของวันที่เลือก</p>
          </div>
          {loading ? <div className="state">กำลังโหลดตารางนัด</div> : null}
          {error ? <div className="state error">{error}</div> : null}
          {!loading && bookings.length === 0 ? <div className="state">ยังไม่มี booking ในวันนี้</div> : null}
          <div className="list">
            {bookings.map((booking) => (
              <a className="admin-row" href={`/admin/bookings/${booking.id}`} key={booking.id}>
                <span className="row-title">{formatDateTime(booking.start_at)} · {booking.customer?.name}</span>
                <span className="meta">
                  <span>{booking.service?.name}</span>
                  <span>{booking.staff?.name}</span>
                  <span>{formatMoney(booking.service?.price)}</span>
                  <span className={`status ${booking.status}`}>{booking.status}</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function handoffReason(reason) {
  return ({ complaint: "ข้อร้องเรียน", discount_request: "ขอส่วนลด", policy_exception: "ขอยกเว้นนโยบาย", human_requested: "ขอคุยกับพนักงาน" })[reason] ?? "ต้องการความช่วยเหลือ";
}

function buildStats(bookings) {
  return {
    today: bookings.filter((booking) => ["pending", "confirmed", "checked_in"].includes(booking.status)).length,
    completed: bookings.filter((booking) => booking.status === "completed").length,
    cancelled: bookings.filter((booking) => booking.status === "cancelled").length,
    no_show: bookings.filter((booking) => booking.status === "no_show").length
  };
}

function Header() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <strong>Salon Booking OS</strong>
        <span>Admin</span>
      </a>
      <nav className="nav-links">
        <a href="/">จองคิว</a>
        <a href="/manage">จัดการนัด</a>
        <a href="/admin/payments">ตรวจสอบสลิป</a>
        <a href="/admin/settings">ตั้งค่าร้าน</a>
      </nav>
    </header>
  );
}

function todayInBangkok() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || "request failed");
  }
  return body.data;
}

export default AdminDashboardClient;
