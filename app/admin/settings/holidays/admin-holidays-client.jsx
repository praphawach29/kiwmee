"use client";

import { useEffect, useState } from "react";
import AdminGate from "../../admin-gate.jsx";
import SettingsNav from "../settings-nav.jsx";

export default function AdminHolidaysClient() {
  const [closures, setClosures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // New closure form state
  const [closureDate, setClosureDate] = useState("");
  const [isAllDay, setIsAllDay] = useState(true);
  const [startTime, setStartTime] = useState("13:00");
  const [endTime, setEndTime] = useState("15:00");
  const [reason, setReason] = useState("");

  useEffect(() => {
    loadClosures();
  }, []);

  async function loadClosures() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/settings/holidays");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load closures");
      setClosures(data.data?.closures || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddClosure(e) {
    e.preventDefault();
    if (!closureDate) {
      setError("กรุณาเลือกวันที่");
      return;
    }
    setActionLoading(true);
    setError("");
    setSuccess("");

    try {
      const payload = {
        closure_date: closureDate,
        is_all_day: isAllDay,
        reason: reason.trim() || undefined
      };
      if (!isAllDay) {
        payload.start_time = startTime;
        payload.end_time = endTime;
      }

      const res = await fetch("/api/admin/settings/holidays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "เพิ่มวันหยุดไม่สำเร็จ");

      setSuccess("บันทึกวันหยุด/ปิดทำการเรียบร้อยแล้ว");
      setClosureDate("");
      setReason("");
      await loadClosures();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("ต้องการลบวันหยุดนี้ใช่หรือไม่?")) return;
    setActionLoading(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/admin/settings/holidays/${id}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "ลบรายการไม่สำเร็จ");
      setSuccess("ลบวันหยุดเรียบร้อยแล้ว");
      await loadClosures();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <AdminGate>
      <main className="app-shell">
        <SettingsNav activeTab="holidays" />
        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>วันหยุดร้านและช่วงปิดทำการ (Business Closures & Holidays)</h1>
              <p>ระบบจะระงับการจองในวันที่หรือช่วงเวลาที่ร้านปิดทำการโดยอัตโนมัติ</p>
            </div>

            {error && <div className="state error">{error}</div>}
            {success && <div className="state" style={{ color: "var(--ok)", borderColor: "var(--ok)", background: "rgba(28, 124, 71, 0.08)" }}>{success}</div>}

            {/* Add Closure Form */}
            <form onSubmit={handleAddClosure} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", marginTop: "16px" }}>
              <h3 style={{ margin: "0 0 12px" }}>➕ เพิ่มวันหยุดหรือช่วงปิดทำการ</h3>
              <div className="field-grid two">
                <label className="field">
                  <span>วันที่</span>
                  <input
                    type="date"
                    value={closureDate}
                    onChange={(e) => setClosureDate(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>สาเหตุ / รายละเอียด</span>
                  <input
                    type="text"
                    placeholder="เช่น วันหยุดปีใหม่, ปรับปรุงระบบน้ำ"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              </div>

              <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px" }}>
                <input
                  type="checkbox"
                  id="all-day-check"
                  checked={isAllDay}
                  onChange={(e) => setIsAllDay(e.target.checked)}
                  style={{ width: "18px", height: "18px", accentColor: "var(--accent)" }}
                />
                <label htmlFor="all-day-check" style={{ fontWeight: 700, cursor: "pointer" }}>
                  ปิดทั้งวัน (All Day)
                </label>
              </div>

              {!isAllDay && (
                <div className="field-grid two" style={{ marginTop: "12px" }}>
                  <label className="field">
                    <span>เวลาเริ่มปิด</span>
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>เวลาสิ้นสุดการปิด</span>
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      required
                    />
                  </label>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
                <button type="submit" className="primary-button" disabled={actionLoading}>
                  {actionLoading ? "กำลังบันทึก..." : "เพิ่มวันหยุด"}
                </button>
              </div>
            </form>

            {/* List of Closures */}
            <div style={{ marginTop: "24px" }}>
              <h2>รายการวันหยุดและปิดทำการ ({closures.length})</h2>
              {loading && <div className="state">กำลังโหลดรายการ...</div>}
              {!loading && closures.length === 0 && <div className="state">ยังไม่มีการบันทึกวันหยุด</div>}
              <div className="list" style={{ marginTop: "12px" }}>
                {closures.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "14px",
                      background: "var(--surface)",
                      border: "1px solid var(--line)",
                      borderRadius: "8px",
                      flexWrap: "wrap",
                      gap: "12px"
                    }}
                  >
                    <div>
                      <strong style={{ display: "block", fontSize: "16px" }}>
                        📅 {item.closure_date} {item.is_all_day ? "(ปิดทั้งวัน)" : `(${item.start_time?.slice(0, 5)} - ${item.end_time?.slice(0, 5)})`}
                      </strong>
                      <span className="meta" style={{ marginTop: "4px" }}>
                        {item.reason || "ไม่มีระบุสาเหตุ"}
                      </span>
                    </div>
                    <div>
                      <button
                        type="button"
                        className="ghost-button"
                        style={{ color: "var(--warn)", borderColor: "var(--warn)" }}
                        onClick={() => handleDelete(item.id)}
                        disabled={actionLoading}
                      >
                        ลบ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
    </AdminGate>
  );
}
