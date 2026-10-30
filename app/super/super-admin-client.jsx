"use client";

// /super: platform admins set the LINE keys here instead of in code. Sign-in is the same session as
// /dashboard. Secrets are write-only: the page only learns whether one is set and its last 4 characters.

import { useCallback, useEffect, useState } from "react";
import { api } from "../dashboard/api.mjs";

const SOURCE = { database: "ตั้งไว้ที่นี่", environment: "ใช้ค่าจากเซิร์ฟเวอร์ (env)", none: "ยังไม่ได้ตั้ง" };
const TONE = { database: "ok", environment: "info", none: "warn" };

export default function SuperAdmin() {
  const [user, setUser] = useState(undefined);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api("GET", "/api/super/settings"));
      setError("");
    } catch (e) {
      setData(null);
      setError(e.status === 403 ? "บัญชีนี้ไม่ใช่ผู้ดูแลแพลตฟอร์ม" : e.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const session = await api("GET", "/api/dashboard/session").catch(() => ({ user: null }));
      setUser(session.user);
      if (session.user) await load();
    })();
  }, [load]);

  return (
    <main className="ad-shell ad-narrow">
      <header className="ad-header">
        <a href="/" className="ad-brand" aria-label="Kiwmee หน้าแรก"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" /></a>
        <h1>ผู้ดูแลแพลตฟอร์ม</h1>
        {user && <p className="ad-muted">{user.email}</p>}
      </header>

      {user === undefined && <p className="ad-muted">กำลังโหลด…</p>}
      {user === null && (
        <section className="ad-card">
          <p>กรุณาเข้าสู่ระบบก่อน</p>
          <p className="ad-muted"><a className="ad-link" href="/dashboard">เข้าสู่ระบบที่หน้าจัดการร้าน</a> แล้วกลับมาที่หน้านี้</p>
        </section>
      )}
      {user && error && <p className="ad-error">{error}</p>}
      {data && (
        <>
          <h2>LINE</h2>
          {!data.encryptionReady && (
            <p className="ad-notice">
              ยังไม่ได้ตั้ง <code>SETTINGS_ENCRYPTION_KEY</code> (อย่างน้อย 32 ตัวอักษร) บน Railway จึงบันทึกค่าที่เป็นความลับไม่ได้
              ค่าที่ไม่ลับ (LIFF ID, Channel ID) บันทึกได้ตามปกติ
            </p>
          )}
          {data.settings.map((setting) => (
            <SettingCard key={setting.key} setting={setting} canSaveSecret={data.encryptionReady} onChanged={load} />
          ))}
          <TestToken />
        </>
      )}
    </main>
  );
}

function SettingCard({ setting, canSaveSecret, onChanged }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const blocked = setting.secret && !canSaveSecret;

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDone("");
    try {
      await api("PUT", "/api/super/settings", { key: setting.key, value });
      setValue("");
      setDone("บันทึกแล้ว");
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm(`ลบค่า ${setting.label} ที่ตั้งไว้ที่นี่?`)) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      await api("DELETE", "/api/super/settings", { key: setting.key });
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ad-card" onSubmit={save} autoComplete="off">
      <div className="ad-row ad-wrap ad-between">
        <strong>{setting.label}</strong>
        <span className="ad-status" data-tone={TONE[setting.source]}>{SOURCE[setting.source]}</span>
      </div>
      <p className="ad-muted">{setting.help}</p>
      {setting.source === "database" && (
        <p className="ad-muted">ค่าปัจจุบัน: <code>{setting.secret ? setting.hint : setting.value}</code></p>
      )}
      <label className="ad-field">
        <span>{setting.source === "database" ? "เปลี่ยนเป็น" : "ค่าใหม่"}</span>
        <input
          type={setting.secret ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          disabled={busy || blocked}
          placeholder={setting.secret ? "วางค่าลับที่นี่ (บันทึกแล้วจะไม่แสดงอีก)" : ""}
        />
      </label>
      {error && <p className="ad-error">{error}</p>}
      {done && <p className="ad-muted">{done}</p>}
      <div className="ad-row ad-wrap">
        <button className="ad-primary" disabled={busy || blocked || !value.trim()}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        {setting.source === "database" && (
          <button type="button" className="ad-link" onClick={clear} disabled={busy}>ลบค่าที่ตั้งไว้</button>
        )}
      </div>
    </form>
  );
}

function TestToken() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  async function test() {
    setBusy(true);
    setResult("");
    setError("");
    try {
      const info = await api("POST", "/api/super/settings/test", {});
      setResult(`เชื่อมต่อได้: ${info.name ?? "(ไม่มีชื่อ)"}${info.basicId ? ` · ${info.basicId}` : ""}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ad-card">
      <strong>ทดสอบการเชื่อมต่อ</strong>
      <p className="ad-muted">ถาม LINE ว่า Channel access token ที่ใช้อยู่ใช้งานได้ไหม (ไม่ได้ส่งข้อความหาใคร)</p>
      {error && <p className="ad-error">{error}</p>}
      {result && <p className="ad-notice">{result}</p>}
      <button type="button" className="ad-secondary" onClick={test} disabled={busy}>{busy ? "กำลังทดสอบ…" : "ทดสอบ token"}</button>
    </section>
  );
}
