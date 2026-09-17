"use client";

import { useEffect, useState } from "react";
import AdminGate from "../admin-gate.jsx";
import SettingsNav from "./settings-nav.jsx";

export default function SettingsOverviewClient() {
  const [bookingSettings, setBookingSettings] = useState(null);
  const [hours, setHours] = useState([]);
  const [closures, setClosures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError("");
      try {
        const [hRes, cRes, bRes] = await Promise.all([
          fetch("/api/admin/settings/hours").then((r) => r.json()),
          fetch("/api/admin/settings/holidays").then((r) => r.json()),
          fetch("/api/admin/settings/booking").then((r) => r.json())
        ]);
        if (hRes.data) setHours(hRes.data.hours || []);
        if (cRes.data) setClosures(cRes.data.closures || []);
        if (bRes.data) setBookingSettings(bRes.data.settings || {});
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const openDaysCount = hours.filter((h) => h.is_open).length;

  return (
    <AdminGate>
      <main className="app-shell">
        <SettingsNav activeTab="overview" />
        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>ตั้งค่าร้านและเวลาทำการ (Admin Settings)</h1>
              <p>ระบบกำหนดเวลาทำการ วันหยุด ตารางงานช่าง และเงื่อนไขการจองที่เชื่อมตรงกับ Availability Engine</p>
            </div>

            {loading && <div className="state">กำลังโหลดข้อมูลการตั้งค่า...</div>}
            {error && <div className="state error">{error}</div>}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginTop: "16px" }}>
              <a href="/admin/settings/hours" className="option-button" style={{ textDecoration: "none", display: "block" }}>
                <span className="option-title">⏰ เวลาเปิด-ปิดร้าน</span>
                <span className="meta">เปิดทำการ {openDaysCount} วัน / สัปดาห์</span>
                <p style={{ margin: "8px 0 0", fontSize: "14px", color: "var(--muted)" }}>
                  กำหนดเวลาเปิด-ปิดในแต่ละวันของสัปดาห์ และระบุวันหยุดประจำสัปดาห์
                </p>
              </a>

              <a href="/admin/settings/holidays" className="option-button" style={{ textDecoration: "none", display: "block" }}>
                <span className="option-title">🏖️ วันหยุดร้าน / ปิดทำการ</span>
                <span className="meta">บันทึกวันหยุดแล้ว {closures.length} รายการ</span>
                <p style={{ margin: "8px 0 0", fontSize: "14px", color: "var(--muted)" }}>
                  ตั้งวันหยุดนักขัตฤกษ์ วันหยุดพิเศษ หรือปิดร้านชั่วคราวบางช่วงเวลา
                </p>
              </a>

              <a href="/admin/settings/staff-schedules" className="option-button" style={{ textDecoration: "none", display: "block" }}>
                <span className="option-title">✂️ ตารางงานและวันลาช่าง</span>
                <span className="meta">จัดการตารางงานช่างแต่ละคน</span>
                <p style={{ margin: "8px 0 0", fontSize: "14px", color: "var(--muted)" }}>
                  กำหนดวันเข้างาน กะเวลาทำงาน และบันทึกการลางานของช่าง
                </p>
              </a>

              <a href="/admin/settings/booking" className="option-button" style={{ textDecoration: "none", display: "block" }}>
                <span className="option-title">⚙️ นโยบายการจอง</span>
                <span className="meta">
                  {bookingSettings ? `Lead ${bookingSettings.lead_time_minutes} นาที · สล็อตละ ${bookingSettings.slot_interval_minutes} นาที` : "เงื่อนไขการจอง"}
                </span>
                <p style={{ margin: "8px 0 0", fontSize: "14px", color: "var(--muted)" }}>
                  กำหนดเวลาแจ้งล่วงหน้า (Lead Time), ขนาดสล็อต, และระยะเวลาจองล่วงหน้าสูงสุด
                </p>
              </a>
            </div>
          </div>
        </section>
      </main>
    </AdminGate>
  );
}
