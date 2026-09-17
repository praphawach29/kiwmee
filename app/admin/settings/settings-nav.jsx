"use client";

export default function SettingsNav({ activeTab = "overview" }) {
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/admin">
          <strong>Salon Booking OS</strong>
          <span>Admin Settings</span>
        </a>
        <nav className="nav-links">
          <a href="/admin">ตารางนัด</a>
          <a href="/admin/payments">ตรวจสอบสลิป</a>
          <a href="/admin/settings" style={activeTab === "overview" ? { borderColor: "var(--accent)", fontWeight: "bold" } : {}}>ตั้งค่าร้าน</a>
        </nav>
      </header>

      <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)", padding: "10px clamp(16px, 4vw, 48px)" }}>
        <div style={{ maxWidth: "1120px", margin: "0 auto", display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <a
            href="/admin/settings/hours"
            className="ghost-button"
            style={activeTab === "hours" ? { borderColor: "var(--accent)", background: "rgba(15, 118, 110, 0.08)", fontWeight: 700 } : {}}
          >
            ⏰ เวลาเปิด-ปิดร้าน
          </a>
          <a
            href="/admin/settings/holidays"
            className="ghost-button"
            style={activeTab === "holidays" ? { borderColor: "var(--accent)", background: "rgba(15, 118, 110, 0.08)", fontWeight: 700 } : {}}
          >
            🏖️ วันหยุดร้าน
          </a>
          <a
            href="/admin/settings/staff-schedules"
            className="ghost-button"
            style={activeTab === "staff-schedules" ? { borderColor: "var(--accent)", background: "rgba(15, 118, 110, 0.08)", fontWeight: 700 } : {}}
          >
            ✂️ ตารางงานช่าง
          </a>
          <a
            href="/admin/settings/booking"
            className="ghost-button"
            style={activeTab === "booking" ? { borderColor: "var(--accent)", background: "rgba(15, 118, 110, 0.08)", fontWeight: 700 } : {}}
          >
            ⚙️ การตั้งค่าการจอง
          </a>
        </div>
      </div>
    </>
  );
}
