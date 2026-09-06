"use client";

import { useState } from "react";

function ManageLookupClient() {
  const [bookingId, setBookingId] = useState("");

  return (
    <main className="app-shell">
      <Header />
      <section className="workspace">
        <div className="work-panel">
          <div className="panel-heading">
            <h1>จัดการนัด</h1>
            <p>กรอก Booking reference เพื่อดูรายละเอียด เปลี่ยนเวลา หรือยกเลิกนัด</p>
          </div>
          <label className="field">
            <span>Booking reference</span>
            <input value={bookingId} onChange={(event) => setBookingId(event.target.value)} placeholder="uuid" />
          </label>
          <a className="primary-button" aria-disabled={!bookingId.trim()} href={bookingId.trim() ? `/manage/${bookingId.trim()}` : "/manage"}>
            ดู booking
          </a>
        </div>
      </section>
    </main>
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

export default ManageLookupClient;
