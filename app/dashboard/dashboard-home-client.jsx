"use client";

// /dashboard: sign in (or sign up, or reset the password) with Supabase Auth, then pick one of your
// shops or open a new one. Links from Supabase's emails land here with the session in the URL hash.

import { useCallback, useEffect, useState } from "react";
import { api, supabaseAuth } from "./api.mjs";

const SHOP_KINDS = { salon: "ร้านเสริมสวย", barber: "ร้านตัดผมชาย", spa: "สปา / นวด", court: "สนามกีฬา", other: "อื่น ๆ" };
const ROLE = { owner: "เจ้าของ", staff: "พนักงาน" };

export default function DashboardHome({ auth }) {
  const [user, setUser] = useState(undefined);
  const [recoveryToken, setRecoveryToken] = useState(null);
  const [notice, setNotice] = useState("");

  const keepSession = useCallback(async (accessToken, refreshToken) => {
    const data = await api("POST", "/api/dashboard/session", { accessToken, refreshToken });
    setUser(data.user);
  }, []);

  useEffect(() => {
    (async () => {
      // A link from a Supabase email: #access_token=…&refresh_token=…&type=signup|recovery
      const hash = new URLSearchParams(window.location.hash.slice(1));
      if (hash.get("access_token") && hash.get("refresh_token")) {
        window.history.replaceState(null, "", window.location.pathname);
        try {
          await keepSession(hash.get("access_token"), hash.get("refresh_token"));
          if (hash.get("type") === "recovery") setRecoveryToken(hash.get("access_token"));
          if (hash.get("type") === "signup") setNotice("ยืนยันอีเมลแล้ว ยินดีต้อนรับ");
          return;
        } catch {
          setNotice("ลิงก์หมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่");
        }
      } else if (hash.get("error_description")) {
        window.history.replaceState(null, "", window.location.pathname);
        setNotice(hash.get("error_description"));
      }
      const data = await api("GET", "/api/dashboard/session").catch(() => ({ user: null }));
      setUser(data.user);
    })();
  }, [keepSession]);

  async function signOut() {
    await api("DELETE", "/api/dashboard/session").catch(() => {});
    setUser(null);
  }

  return (
    <main className="ad-shell ad-narrow">
      <header className="ad-header">
        <h1>จัดการร้าน</h1>
        {user && (
          <p className="ad-muted">
            {user.email} · <button className="ad-link" onClick={signOut}>ออกจากระบบ</button>
          </p>
        )}
      </header>
      {notice && <p className="ad-notice">{notice}</p>}
      {!auth ? (
        <section className="ad-card">
          <h2>ยังไม่ได้ตั้งค่าระบบล็อกอิน</h2>
          <p className="ad-muted">ตั้ง <code>SUPABASE_URL</code> และ <code>SUPABASE_PUBLISHABLE_KEY</code> บนเซิร์ฟเวอร์ก่อน</p>
        </section>
      ) : user === undefined ? (
        <p className="ad-muted">กำลังโหลด…</p>
      ) : recoveryToken ? (
        <NewPassword auth={auth} accessToken={recoveryToken} onDone={() => { setRecoveryToken(null); setNotice("ตั้งรหัสผ่านใหม่แล้ว"); }} />
      ) : user ? (
        <Shops />
      ) : (
        <SignIn auth={auth} onSession={keepSession} onNotice={setNotice} />
      )}
    </main>
  );
}

function SignIn({ auth, onSession, onNotice }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const back = `?redirect_to=${encodeURIComponent(`${window.location.origin}/dashboard`)}`;
    try {
      if (mode === "signin") {
        const s = await supabaseAuth(auth, "token?grant_type=password", { email, password });
        await onSession(s.access_token, s.refresh_token);
      } else if (mode === "signup") {
        const s = await supabaseAuth(auth, `signup${back}`, { email, password });
        if (s.access_token) await onSession(s.access_token, s.refresh_token);
        else onNotice(`ส่งลิงก์ยืนยันไปที่ ${email} แล้ว กดลิงก์ในอีเมลเพื่อเริ่มใช้งาน`);
      } else {
        await supabaseAuth(auth, `recover${back}`, { email });
        onNotice(`ถ้ามีบัญชี ${email} อยู่ ระบบส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว`);
        setMode("signin");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const title = { signin: "เข้าสู่ระบบ", signup: "สมัครใช้งาน", recover: "ลืมรหัสผ่าน" }[mode];
  return (
    <form className="ad-card" onSubmit={submit}>
      <h2>{title}</h2>
      <label className="ad-field">
        อีเมล
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {mode !== "recover" && (
        <label className="ad-field">
          รหัสผ่าน
          <input
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
      {error && <p className="ad-error">{error}</p>}
      <button className="ad-primary" disabled={busy}>{busy ? "กำลังส่ง…" : title}</button>
      <p className="ad-muted ad-row">
        {mode !== "signin" && <button type="button" className="ad-link" onClick={() => setMode("signin")}>เข้าสู่ระบบ</button>}
        {mode !== "signup" && <button type="button" className="ad-link" onClick={() => setMode("signup")}>สมัครใช้งาน</button>}
        {mode !== "recover" && <button type="button" className="ad-link" onClick={() => setMode("recover")}>ลืมรหัสผ่าน</button>}
      </p>
    </form>
  );
}

function NewPassword({ auth, accessToken, onDone }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    try {
      await supabaseAuth(auth, "user", { password }, accessToken);
      onDone();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <form className="ad-card" onSubmit={submit}>
      <h2>ตั้งรหัสผ่านใหม่</h2>
      <label className="ad-field">
        รหัสผ่านใหม่
        <input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="ad-error">{error}</p>}
      <button className="ad-primary">บันทึก</button>
    </form>
  );
}

function Shops() {
  const [shops, setShops] = useState(null);
  const [form, setForm] = useState({ name: "", slug: "", kind: "salon" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("GET", "/api/dashboard/shops").then(setShops, (e) => setError(e.message));
  }, []);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { slug } = await api("POST", "/api/dashboard/shops", form);
      window.location.href = `/dashboard/${slug}`;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (!shops) return <p className={error ? "ad-error" : "ad-muted"}>{error || "กำลังโหลด…"}</p>;
  return (
    <>
      {shops.length > 0 && (
        <section className="ad-card">
          <h2>ร้านของคุณ</h2>
          <ul className="ad-list">
            {shops.map((s) => (
              <li key={s.slug}>
                <a className="ad-list-item" href={`/dashboard/${s.slug}`}>
                  <strong>{s.name}</strong>
                  <span className="ad-muted">{SHOP_KINDS[s.kind] ?? s.kind} · {ROLE[s.role]}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form className="ad-card" onSubmit={create}>
        <h2>{shops.length ? "เปิดร้านใหม่" : "เริ่มจากเปิดร้านของคุณ"}</h2>
        <label className="ad-field">
          ชื่อร้าน
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="ad-field">
          ชื่อลิงก์หน้าจอง (a-z, 0-9, -)
          <span className="ad-inline">
            <span className="ad-muted">/b/</span>
            <input
              required
              pattern="[a-z0-9][a-z0-9\-]{1,40}"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })}
            />
          </span>
        </label>
        <label className="ad-field">
          ประเภทร้าน
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(SHOP_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {error && <p className="ad-error">{error}</p>}
        <button className="ad-primary" disabled={busy}>เปิดร้าน</button>
      </form>
    </>
  );
}
