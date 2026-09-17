"use client";

import { useEffect, useState } from "react";
import AdminGate from "../../admin-gate.jsx";
import SettingsNav from "../settings-nav.jsx";

const DAY_NAMES = [
  "วันอาทิตย์ (Sunday)",
  "วันจันทร์ (Monday)",
  "วันอังคาร (Tuesday)",
  "วันพุธ (Wednesday)",
  "วันพฤหัสบดี (Thursday)",
  "วันศุกร์ (Friday)",
  "วันเสาร์ (Saturday)"
];

export default function AdminStaffSchedulesClient() {
  const [staffList, setStaffList] = useState([]);
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [schedules, setSchedules] = useState([]);
  const [timeOffs, setTimeOffs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // New time-off form
  const [toStartDate, setToStartDate] = useState("");
  const [toEndDate, setToEndDate] = useState("");
  const [toIsAllDay, setToIsAllDay] = useState(true);
  const [toStartTime, setToStartTime] = useState("10:00");
  const [toEndTime, setToEndTime] = useState("19:00");
  const [toReason, setToReason] = useState("");

  useEffect(() => {
    loadStaffList();
  }, []);

  useEffect(() => {
    if (selectedStaffId) {
      loadStaffData(selectedStaffId);
    }
  }, [selectedStaffId]);

  async function loadStaffList() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/staff");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load staff list");
      const list = data.data || [];
      setStaffList(list);
      if (list.length > 0 && !selectedStaffId) {
        setSelectedStaffId(list[0].id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadStaffData(staffId) {
    setError("");
    try {
      const [schedRes, toRes] = await Promise.all([
        fetch(`/api/admin/settings/staff-schedules?staff_id=${staffId}`).then((r) => r.json()),
        fetch(`/api/admin/settings/staff-time-off?staff_id=${staffId}`).then((r) => r.json())
      ]);

      const existingScheds = schedRes.data?.schedules || [];
      const fullWeek = [0, 1, 2, 3, 4, 5, 6].map((day) => {
        const found = existingScheds.find((s) => Number(s.day_of_week) === day);
        return found
          ? {
              staff_id: staffId,
              day_of_week: day,
              is_working: Boolean(found.is_working),
              start_time: found.start_time?.slice(0, 5) || "10:00",
              end_time: found.end_time?.slice(0, 5) || "19:00"
            }
          : {
              staff_id: staffId,
              day_of_week: day,
              is_working: true,
              start_time: "10:00",
              end_time: "19:00"
            };
      });
      setSchedules(fullWeek);
      setTimeOffs(toRes.data?.time_offs || []);
    } catch (err) {
      setError(err.message);
    }
  }

  function handleScheduleChange(dayIndex, field, value) {
    setSchedules((prev) =>
      prev.map((item) =>
        item.day_of_week === dayIndex ? { ...item, [field]: value } : item
      )
    );
  }

  async function handleSaveSchedule(e) {
    e.preventDefault();
    setSavingSchedule(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/settings/staff-schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedules })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "บันทึกตารางงานไม่สำเร็จ");
      setSuccess("บันทึกตารางงานช่างเรียบร้อยแล้ว");
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleAddTimeOff(e) {
    e.preventDefault();
    if (!toStartDate) {
      setError("กรุณาระบุวันเริ่มต้น");
      return;
    }
    setActionLoading(true);
    setError("");
    setSuccess("");

    try {
      const payload = {
        staff_id: selectedStaffId,
        start_date: toStartDate,
        end_date: toEndDate || toStartDate,
        is_all_day: toIsAllDay,
        reason: toReason.trim() || undefined
      };
      if (!toIsAllDay) {
        payload.start_time = toStartTime;
        payload.end_time = toEndTime;
      }

      const res = await fetch("/api/admin/settings/staff-time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "เพิ่มวันลาไม่สำเร็จ");

      setSuccess("บันทึกการลางานของช่างเรียบร้อยแล้ว");
      setToStartDate("");
      setToEndDate("");
      setToReason("");
      await loadStaffData(selectedStaffId);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeleteTimeOff(id) {
    if (!window.confirm("ต้องการลบรายการลางานนี้ใช่หรือไม่?")) return;
    setActionLoading(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/admin/settings/staff-time-off/${id}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "ลบรายการไม่สำเร็จ");
      setSuccess("ลบรายการลางานเรียบร้อยแล้ว");
      await loadStaffData(selectedStaffId);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <AdminGate>
      <main className="app-shell">
        <SettingsNav activeTab="staff-schedules" />
        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>ตารางงานและวันลาช่าง (Staff Schedules & Time Off)</h1>
              <p>กำหนดวันเข้างาน กะเวลา และวันลาของช่างแต่ละคนเพื่อใช้คำนวณสล็อตว่าง</p>
            </div>

            {loading && <div className="state">กำลังโหลดรายชื่อช่าง...</div>}
            {error && <div className="state error">{error}</div>}
            {success && <div className="state" style={{ color: "var(--ok)", borderColor: "var(--ok)", background: "rgba(28, 124, 71, 0.08)" }}>{success}</div>}

            {!loading && (
              <>
                <div style={{ marginTop: "16px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px" }}>
                  <label className="field">
                    <span>เลือกช่างที่ต้องการจัดการ:</span>
                    <select
                      value={selectedStaffId}
                      onChange={(e) => setSelectedStaffId(e.target.value)}
                      style={{ maxWidth: "320px" }}
                    >
                      {staffList.map((st) => (
                        <option key={st.id} value={st.id}>
                          {st.name} ({st.role || "ช่าง"})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {selectedStaffId && (
                  <>
                    {/* Weekly Schedule Form */}
                    <form onSubmit={handleSaveSchedule} style={{ marginTop: "24px" }}>
                      <h2>⏰ ตารางงานประจำสัปดาห์</h2>
                      <div style={{ display: "grid", gap: "10px", marginTop: "12px" }}>
                        {schedules.map((item) => (
                          <div
                            key={item.day_of_week}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "12px 16px",
                              background: item.is_working ? "var(--surface)" : "#f1ede6",
                              border: "1px solid var(--line)",
                              borderRadius: "8px",
                              flexWrap: "wrap",
                              gap: "12px",
                              opacity: item.is_working ? 1 : 0.7
                            }}
                          >
                            <div style={{ minWidth: "180px", display: "flex", alignItems: "center", gap: "10px" }}>
                              <input
                                type="checkbox"
                                id={`sched-${item.day_of_week}`}
                                checked={item.is_working}
                                onChange={(e) => handleScheduleChange(item.day_of_week, "is_working", e.target.checked)}
                                style={{ width: "18px", height: "18px", accentColor: "var(--accent)" }}
                              />
                              <label htmlFor={`sched-${item.day_of_week}`} style={{ fontWeight: 700, cursor: "pointer" }}>
                                {DAY_NAMES[item.day_of_week]}
                              </label>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              {item.is_working ? (
                                <>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ fontSize: "14px", color: "var(--muted)" }}>เริ่มงาน:</span>
                                    <input
                                      type="time"
                                      value={item.start_time}
                                      onChange={(e) => handleScheduleChange(item.day_of_week, "start_time", e.target.value)}
                                      style={{ padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--line)" }}
                                      required
                                    />
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ fontSize: "14px", color: "var(--muted)" }}>เลิกงาน:</span>
                                    <input
                                      type="time"
                                      value={item.end_time}
                                      onChange={(e) => handleScheduleChange(item.day_of_week, "end_time", e.target.value)}
                                      style={{ padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--line)" }}
                                      required
                                    />
                                  </div>
                                </>
                              ) : (
                                <span style={{ color: "var(--warn)", fontWeight: 700, fontSize: "14px" }}>วันหยุดประจำสัปดาห์</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
                        <button type="submit" className="primary-button" disabled={savingSchedule}>
                          {savingSchedule ? "กำลังบันทึก..." : "บันทึกตารางงาน"}
                        </button>
                      </div>
                    </form>

                    {/* Time Off Section */}
                    <div style={{ marginTop: "36px" }}>
                      <h2>🏖️ บันทึกการลางาน / ไม่อยู่ร้าน</h2>

                      {/* Add Time Off Form */}
                      <form onSubmit={handleAddTimeOff} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "8px", padding: "16px", marginTop: "12px" }}>
                        <h3 style={{ margin: "0 0 12px" }}>➕ บันทึกวันลาใหม่</h3>
                        <div className="field-grid two">
                          <label className="field">
                            <span>วันที่เริ่มต้น</span>
                            <input
                              type="date"
                              value={toStartDate}
                              onChange={(e) => setToStartDate(e.target.value)}
                              required
                            />
                          </label>
                          <label className="field">
                            <span>วันที่สิ้นสุด (เว้นว่างได้ถ้าลา 1 วัน)</span>
                            <input
                              type="date"
                              value={toEndDate}
                              onChange={(e) => setToEndDate(e.target.value)}
                            />
                          </label>
                        </div>

                        <label className="field" style={{ marginTop: "12px" }}>
                          <span>เหตุผลการลา</span>
                          <input
                            type="text"
                            placeholder="เช่น ลาพักร้อน, ติดธุระด่วน"
                            value={toReason}
                            onChange={(e) => setToReason(e.target.value)}
                          />
                        </label>

                        <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "10px" }}>
                          <input
                            type="checkbox"
                            id="to-all-day"
                            checked={toIsAllDay}
                            onChange={(e) => setToIsAllDay(e.target.checked)}
                            style={{ width: "18px", height: "18px", accentColor: "var(--accent)" }}
                          />
                          <label htmlFor="to-all-day" style={{ fontWeight: 700, cursor: "pointer" }}>
                            ลาทั้งวัน (All Day)
                          </label>
                        </div>

                        {!toIsAllDay && (
                          <div className="field-grid two" style={{ marginTop: "12px" }}>
                            <label className="field">
                              <span>เวลาเริ่มลา</span>
                              <input
                                type="time"
                                value={toStartTime}
                                onChange={(e) => setToStartTime(e.target.value)}
                                required
                              />
                            </label>
                            <label className="field">
                              <span>เวลาสิ้นสุดการลา</span>
                              <input
                                type="time"
                                value={toEndTime}
                                onChange={(e) => setToEndTime(e.target.value)}
                                required
                              />
                            </label>
                          </div>
                        )}

                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
                          <button type="submit" className="primary-button" disabled={actionLoading}>
                            {actionLoading ? "กำลังบันทึก..." : "บันทึกวันลา"}
                          </button>
                        </div>
                      </form>

                      {/* Time Off List */}
                      <div style={{ marginTop: "20px" }}>
                        <h3>รายการลางาน ({timeOffs.length})</h3>
                        {timeOffs.length === 0 && <div className="state">ไม่มีรายการลางาน</div>}
                        <div className="list" style={{ marginTop: "12px" }}>
                          {timeOffs.map((item) => (
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
                                  📅 {item.start_date} {item.end_date && item.end_date !== item.start_date ? `ถึง ${item.end_date}` : ""} {item.is_all_day ? "(ทั้งวัน)" : `(${item.start_time?.slice(0, 5)} - ${item.end_time?.slice(0, 5)})`}
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
                                  onClick={() => handleDeleteTimeOff(item.id)}
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
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </AdminGate>
  );
}
