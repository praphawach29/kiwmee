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

export default function AdminHoursClient() {
  const [hours, setHours] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    loadHours();
  }, []);

  async function loadHours() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/settings/hours");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to load business hours");

      // Ensure all 7 days exist (0 to 6)
      const existing = data.data?.hours || [];
      const fullWeek = [0, 1, 2, 3, 4, 5, 6].map((day) => {
        const found = existing.find((h) => Number(h.day_of_week) === day);
        return found
          ? {
              day_of_week: day,
              is_open: Boolean(found.is_open),
              open_time: found.open_time?.slice(0, 5) || "10:00",
              close_time: found.close_time?.slice(0, 5) || "19:00"
            }
          : {
              day_of_week: day,
              is_open: true,
              open_time: "10:00",
              close_time: "19:00"
            };
      });
      setHours(fullWeek);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDayChange(dayIndex, field, value) {
    setHours((prev) =>
      prev.map((item) =>
        item.day_of_week === dayIndex ? { ...item, [field]: value } : item
      )
    );
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/settings/hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "บันทึกเวลาทำการไม่สำเร็จ");
      setSuccess("บันทึกเวลาทำการของร้านเรียบร้อยแล้ว");
      if (data.data?.hours) {
        setHours(data.data.hours.map((h) => ({
          day_of_week: Number(h.day_of_week),
          is_open: Boolean(h.is_open),
          open_time: h.open_time?.slice(0, 5) || "10:00",
          close_time: h.close_time?.slice(0, 5) || "19:00"
        })));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminGate>
      <main className="app-shell">
        <SettingsNav activeTab="hours" />
        <section className="workspace admin-layout">
          <div className="work-panel">
            <div className="panel-heading">
              <h1>เวลาเปิด-ปิดร้านประจำสัปดาห์ (Weekly Business Hours)</h1>
              <p>กำหนดเวลาเปิดทำการในแต่ละวัน หากปิดทำการในวันใด ระบบจะปิดการจองในวันนั้นทันที</p>
            </div>

            {loading && <div className="state">กำลังโหลดข้อมูลเวลาทำการ...</div>}
            {error && <div className="state error">{error}</div>}
            {success && <div className="state" style={{ color: "var(--ok)", borderColor: "var(--ok)", background: "rgba(28, 124, 71, 0.08)" }}>{success}</div>}

            {!loading && (
              <form onSubmit={handleSave} style={{ display: "grid", gap: "16px", marginTop: "16px" }}>
                <div style={{ display: "grid", gap: "10px" }}>
                  {hours.map((item) => (
                    <div
                      key={item.day_of_week}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 16px",
                        background: item.is_open ? "var(--surface)" : "#f1ede6",
                        border: "1px solid var(--line)",
                        borderRadius: "8px",
                        flexWrap: "wrap",
                        gap: "12px",
                        opacity: item.is_open ? 1 : 0.7
                      }}
                    >
                      <div style={{ minWidth: "200px", display: "flex", alignItems: "center", gap: "10px" }}>
                        <input
                          type="checkbox"
                          id={`day-${item.day_of_week}`}
                          checked={item.is_open}
                          onChange={(e) => handleDayChange(item.day_of_week, "is_open", e.target.checked)}
                          style={{ width: "18px", height: "18px", accentColor: "var(--accent)" }}
                        />
                        <label htmlFor={`day-${item.day_of_week}`} style={{ fontWeight: 700, cursor: "pointer" }}>
                          {DAY_NAMES[item.day_of_week]}
                        </label>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {item.is_open ? (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style={{ fontSize: "14px", color: "var(--muted)" }}>เปิด:</span>
                              <input
                                type="time"
                                value={item.open_time}
                                onChange={(e) => handleDayChange(item.day_of_week, "open_time", e.target.value)}
                                style={{ padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--line)" }}
                                required
                              />
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                              <span style={{ fontSize: "14px", color: "var(--muted)" }}>ปิด:</span>
                              <input
                                type="time"
                                value={item.close_time}
                                onChange={(e) => handleDayChange(item.day_of_week, "close_time", e.target.value)}
                                style={{ padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--line)" }}
                                required
                              />
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--warn)", fontWeight: 700, fontSize: "14px" }}>ปิดทำการ (Closed)</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "12px" }}>
                  <button type="button" className="ghost-button" onClick={loadHours} disabled={saving}>
                    ยกเลิก / คืนค่าเดิม
                  </button>
                  <button type="submit" className="primary-button" disabled={saving}>
                    {saving ? "กำลังบันทึก..." : "บันทึกเวลาทำการ"}
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
