"use client";
import { useEffect, useState } from "react";
export default function AdminGate({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/admin/session").then((r) => r.json()).then((b) => setAuthenticated(Boolean(b.data?.authenticated)))
    .catch(() => setError("ตรวจสอบสิทธิ์ไม่สำเร็จ")).finally(() => setLoading(false)); }, []);
  async function login(event) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new Error("เข้าสู่ระบบไม่สำเร็จ");
      setPassword(""); setAuthenticated(true);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  async function logout() {
    try { await fetch("/api/admin/session", { method: "DELETE" }); } finally { setAuthenticated(false); }
  }
  if (authenticated) return <><div className="admin-session-bar"><span>เข้าสู่ระบบพนักงาน</span><button className="ghost-button" onClick={logout}>ออกจากระบบ</button></div>{children}</>;
  return <main className="app-shell"><h1>เข้าสู่ระบบพนักงาน</h1><form onSubmit={login}>
    <label className="field">รหัสผ่าน<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={loading || !password}>{loading ? "กำลังตรวจสอบ" : "เข้าสู่ระบบ"}</button>
  </form></main>;
}
