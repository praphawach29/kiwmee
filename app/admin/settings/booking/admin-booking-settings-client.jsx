"use client";

import { useEffect, useState } from "react";
import AdminGate from "../../admin-gate.jsx";
import SettingsNav from "../settings-nav.jsx";

export default function AdminBookingSettingsClient() {
  const [leadTimeMinutes, setLeadTimeMinutes] = useState(15);
  const [slotIntervalMinutes, setSlotIntervalMinutes] = useState(15);
  const [maxAdvanceDays, setMaxAdvanceDays] = useState(60);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/settings/booking");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load booking settings");
      const s = data.data?.settings || {};
      if (s.lead_time_minutes !== undefined) setLeadTimeMinutes(s.lead_time_minutes);
      if (s.slot_interval_minutes !== undefined) setSlotIntervalMinutes(s.slot_interval_minutes);
      if (s.max_advance_days !== undefined) setMaxAdvanceDays(s.max_advance_days);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/settings/booking", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_time_minutes: Number(leadTimeMinutes),
          slot_interval_minutes: Number(slotIntervalMinutes),
          max_advance_days: Number(maxAdvanceDays)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "บันทึกการตั้งค่าไม่สำเร็จ");

      setSuccess("บันทึกการตั้งค่านโยบายการจองเรียบร้อยแล้ว");
      const s = data.data?.settings || {};
      if (s.lead_time_minutes !== undefined) setLeadTimeMinutes(s.lead_time_minutes);
      if (s.slot_interval_minutes !== undefined) setSlotIntervalMinutes(s.slot_interval_minutes);
      if (s.max_advance_days !== undefined) setMaxAdvanceDays(s.max_advance_days);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminGate>
      <main className="app-shell">
        <SettingsNav activeTab="booking" />
        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>นโยบายและเงื่อนไขการจองคิว (Booking Policies)</h1>
              <p>ตั้งค่าระยะเวลาขั้นต่ำในการแจ้งล่วงหน้า ขนาดของสล็อตเวลา และระยะเวลาที่เปิดรับจองล่วงหน้า</p>
            </div>

            {loading && <div className="state">กำลังโหลดข้อมูล...</div>}
            {error && <div className="state error">{error}</div>}
            {success && <div className="state" style={{ color: "var(--ok)", borderColor: "var(--ok)", background: "rgba(28, 124, 71, 0.08)" }}>{success}</div>}

            {!loading && (
              <form onSubmit={handleSave} style={{ maxWidth: "600px", marginTop: "16px", display: "grid", gap: "20px" }}>
                <label className="field">
                  <span>ระยะเวลาแจ้งจองล่วงหน้าขั้นต่ำ (Lead Time - นาที)</span>
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    step="5"
                    value={leadTimeMinutes}
                    onChange={(e) => setLeadTimeMinutes(e.target.value)}
                    required
                  />
                  <small style={{ color: "var(--muted)" }}>
                    หากลูกค้าเลือกจอง "วันนี้" ระบบจะตัดสล็อตเวลาที่เหลือน้อยกว่าค่านี้ออกจากผลลัพธ์ (เช่น 15 นาที)
                  </small>
                </label>

                <label className="field">
                  <span>ขนาดช่วงเวลาสล็อต (Slot Interval - นาที)</span>
                  <select
                    value={slotIntervalMinutes}
                    onChange={(e) => setSlotIntervalMinutes(Number(e.target.value))}
                    required
                  >
                    <option value={5}>5 นาที</option>
                    <option value={10}>10 นาที</option>
                    <option value={15}>15 นาที (ค่ามาตรฐาน)</option>
                    <option value={20}>20 นาที</option>
                    <option value={30}>30 นาที</option>
                    <option value={60}>60 นาที (1 ชั่วโมง)</option>
                  </select>
                  <small style={{ color: "var(--muted)" }}>
                    ช่วงความถี่ของรอบเวลาเริ่มนัดหมาย (เช่น ทุก 15 นาที: 10:00, 10:15, 10:30, ...)
                  </small>
                </label>

                <label className="field">
                  <span>เปิดรับจองล่วงหน้าสูงสุด (Max Advance Days - วัน)</span>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={maxAdvanceDays}
                    onChange={(e) => setMaxAdvanceDays(e.target.value)}
                    required
                  />
                  <small style={{ color: "var(--muted)" }}>
                    ลูกค้าสามารถเลือกวันที่จองล่วงหน้าได้ไม่เกินจำนวนวันที่กำหนดนี้ (ค่าเริ่มต้น 60 วัน)
                  </small>
                </label>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
                  <button type="button" className="ghost-button" onClick={loadSettings} disabled={saving}>
                    คืนค่าเดิม
                  </button>
                  <button type="submit" className="primary-button" disabled={saving}>
                    {saving ? "กำลังบันทึก..." : "บันทึกการตั้งค่า"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      </main>
    </AdminGate>
  );
}
