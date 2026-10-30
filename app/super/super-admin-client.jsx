"use client";

// /super: platform admins. Sidebar navigation + section switching (client-side).
// Sign-in is the same session as /dashboard. Secrets are write-only.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../dashboard/api.mjs";
import CatalogSection from "./catalog-section";

const SOURCE = { database: "ตั้งไว้ที่นี่", environment: "ใช้ค่าจากเซิร์ฟเวอร์ (env)", none: "ยังไม่ได้ตั้ง" };
const configured = (setting) => ["database", "environment"].includes(setting?.source);
const TONE = { database: "ok", environment: "info", none: "warn" };

const NAV = [
  { group: "ภาพรวม", items: [{ id: "dash", icon: "▦", label: "แดชบอร์ด" }] },
  { group: "ลูกค้า", items: [
    { id: "brands", icon: "◈", label: "แบรนด์และแพ็กเกจ" },
    { id: "shops", icon: "⌂", label: "ร้านและสาขา" },
  ]},
  { group: "ระบบ", items: [
    { id: "settings", icon: "⚙", label: "การตั้งค่า", children: [
      { id: "line", label: "การเชื่อมต่อ LINE" },
      { id: "security", label: "ความปลอดภัยและกุญแจ" },
    ]},
    { id: "admins", icon: "☺", label: "ผู้ดูแลแพลตฟอร์ม" },
  ]},
];

export default function SuperAdmin() {
  const [user, setUser] = useState(undefined);
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [brandFilter, setBrandFilter] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState("dash");
  const [openGroup, setOpenGroup] = useState("settings");
  const [drawer, setDrawer] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const menuButton = useRef(null);
  const sidebar = useRef(null);
  const content = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await api("GET", "/api/super/settings"));
      setError("");
      return true;
    } catch (e) {
      setDrawer(false);
      setData(null);
      setError(e.status === 403 ? "บัญชีนี้ไม่ใช่ผู้ดูแลแพลตฟอร์ม" : e.message);
      return false;
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalog(null);
    try { setCatalog(await api("GET", "/api/super/catalog")); }
    catch (e) {
      setCatalog({ error: e.message });
      if (e.status === 403 || e.status === 401) {
        setData(null);
        setError(e.status === 403 ? "บัญชีนี้ไม่ใช่ผู้ดูแลแพลตฟอร์ม" : "กรุณาเข้าสู่ระบบอีกครั้ง");
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const session = await api("GET", "/api/dashboard/session").catch(() => ({ user: null }));
      setUser(session.user ?? null);
      if (session.user && await load()) await loadCatalog();
    })();
  }, [load, loadCatalog]);

  useEffect(() => {
    if (!drawer) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebar.current?.querySelector("button")?.focus();
    const close = () => { setDrawer(false); menuButton.current?.focus(); };
    function keydown(event) {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const items = Array.from(sidebar.current?.querySelectorAll('a[href], button:not(:disabled)') || []);
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    const media = window.matchMedia("(max-width: 900px)");
    const resize = () => { if (!media.matches) { setDrawer(false); content.current?.focus(); } };
    document.addEventListener("keydown", keydown);
    media.addEventListener("change", resize);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", keydown);
      media.removeEventListener("change", resize);
    };
  }, [drawer]);

  function parentOf(id) {
    return NAV.flatMap((g) => g.items).find((item) => item.children?.some((child) => child.id === id))?.id;
  }
  function go(id) {
    setPage(id);
    if (parentOf(id)) setOpenGroup(parentOf(id));
    setDrawer(false);
    content.current?.scrollTo(0, 0);
    content.current?.focus();
  }
  function closeDrawer() { setDrawer(false); menuButton.current?.focus(); }
  async function signOut() {
    setSigningOut(true); setLogoutError("");
    try {
      await api("DELETE", "/api/dashboard/session");
      setUser(null); setData(null); setCatalog(null); setDrawer(false);
    } catch (e) { setLogoutError(e.message); }
    finally { setSigningOut(false); }
  }

  if (user === undefined) return <main className="ad-shell ad-narrow"><p role="status" className="ad-muted">กำลังโหลด…</p></main>;
  if (user === null) return (
    <main className="ad-shell ad-narrow"><section className="ad-card">
      <p>กรุณาเข้าสู่ระบบก่อน</p>
      <p className="ad-muted"><a className="ad-link" href="/dashboard">เข้าสู่ระบบที่หน้าจัดการร้าน</a> แล้วกลับมาที่หน้านี้</p>
    </section></main>
  );
  if (!data || error) return (
    <main className="ad-shell ad-narrow"><section className="ad-card">
      {error ? <><p role="alert" className="ad-error">{error}</p><button className="super-btn" onClick={async () => { if (await load()) await loadCatalog(); }}>ลองใหม่</button></> : <p role="status">กำลังตรวจสอบสิทธิ์…</p>}
      <p><a className="ad-link" href="/dashboard">กลับหน้าจัดการร้าน</a></p>
      <button className="super-link" disabled={signingOut} onClick={signOut}>ออกจากระบบ</button>
      {logoutError && <p role="alert" className="ad-error">{logoutError}</p>}
    </section></main>
  );

  const missing = data.settings.filter((setting) => !configured(setting)).length;
  const sectionGroup = NAV.find((group) => group.items.some((item) => item.id === page || item.children?.some((child) => child.id === page)))?.group;
  return (
    <div className="super-layout">
      <a className="super-skip" href="#super-content">ข้ามไปเนื้อหา</a>
      {drawer && <button className="super-backdrop" aria-label="ปิดเมนู" tabIndex={-1} onClick={closeDrawer} />}
      <aside id="super-navigation" ref={sidebar} className={"super-side" + (drawer ? " is-open" : "")} role={drawer ? "dialog" : undefined} aria-modal={drawer ? true : undefined} aria-label="เมนูผู้ดูแลแพลตฟอร์ม">
        <button className="super-drawer-close" onClick={closeDrawer} aria-label="ปิดเมนู">✕</button>
        <a href="/" className="super-brand" aria-label="Kiwmee หน้าแรก"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" width="128" height="40" /><span className="super-tag">SUPER</span></a>
        <div className="super-sub">ระบบจัดการ</div>
        <nav aria-label="เมนูหลัก">
          {NAV.map((group) => <div key={group.group}>
            <div className="super-grp">{group.group}</div>
            {group.items.map((item) => {
              if (item.children) {
                const open = openGroup === item.id;
                return <div key={item.id}>
                  <button className={"super-nav super-parent" + (parentOf(page) === item.id ? " has-on" : "") + (open ? " open" : "")} aria-expanded={open} aria-controls="super-settings-nav" onClick={() => setOpenGroup(open ? null : item.id)}>
                    <span className="super-ic" aria-hidden="true">{item.icon}</span><span className="super-lbl">{item.label}</span>
                    {missing > 0 && <span className="super-badge" aria-label={`ยังไม่ได้ตั้ง ${missing} ค่า`}>{missing}</span>}<span className="super-chev" aria-hidden="true">▾</span>
                  </button>
                  {open && <div id="super-settings-nav" className="super-subnav">{item.children.map((child) => <button key={child.id} className={"super-nav super-subitem" + (page === child.id ? " on" : "")} aria-current={page === child.id ? "page" : undefined} onClick={() => go(child.id)}>
                    <span className="super-lbl">{child.label}</span>{child.id === "line" && missing > 0 && <span className="super-badge">{missing}</span>}
                  </button>)}</div>}
                </div>;
              }
              return <button key={item.id} className={"super-nav" + (page === item.id ? " on" : "")} aria-current={page === item.id ? "page" : undefined} onClick={() => go(item.id)}><span className="super-ic" aria-hidden="true">{item.icon}</span><span className="super-lbl">{item.label}</span></button>;
            })}
          </div>)}
        </nav>
        <div className="super-foot">
          <div className="super-me"><span className="super-avatar" aria-hidden="true">{user.email?.[0]?.toUpperCase() || "A"}</span><div className="super-me-text"><b>{user.email}</b><span>ผู้ดูแลแพลตฟอร์ม</span></div></div>
          <button className="super-logout" disabled={signingOut} onClick={signOut}>{signingOut ? "กำลังออกจากระบบ…" : "↪ ออกจากระบบ"}</button>
          {logoutError && <p className="ad-error" role="alert">{logoutError}</p>}
        </div>
      </aside>
      <main id="super-content" ref={content} tabIndex={-1} className="super-main" inert={drawer ? true : undefined}>
        <header className="super-top">
          <button ref={menuButton} className="super-menu-toggle" aria-label="เปิดเมนู" aria-expanded={drawer} aria-controls="super-navigation" onClick={() => setDrawer(true)}>☰</button>
          <div className="super-crumb">{sectionGroup} / <b>{pageTitle(page)}</b></div><span className="super-sp" />
          <div className="super-top-status">
            <button className={"super-pill2 super-status-button " + (missing ? "warn" : "info")} onClick={() => go("line")}>{missing ? `LINE ยังขาด ${missing} ค่า` : "LINE ตั้งค่าครบ · ยังไม่ยืนยันการเชื่อมต่อ"}</button>
            <button className={"super-pill2 super-status-button " + (data.encryptionReady ? "info" : "warn")} onClick={() => go("security")}>{data.encryptionReady ? "กุญแจเข้ารหัสพร้อม" : "ยังไม่ตั้งกุญแจเข้ารหัส"}</button>
          </div>
        </header>
        <nav className="super-mobile-tabs" aria-label="เมนูลัด">
          {["dash", "brands", "shops", "line"].map((id) => <button key={id} className={page === id ? "on" : ""} aria-current={page === id ? "page" : undefined} onClick={() => go(id)}>{pageTitle(id)}</button>)}
        </nav>
        <div className="super-content">
          <h1 className="super-page-title">{pageTitle(page)}</h1>
          {page === "dash" && <Dashboard data={data} catalog={catalog} go={go} />}
          {page === "line" && <LineSection data={data} error={error} load={load} />}
          {page === "security" && <SecuritySection data={data} signOut={signOut} signingOut={signingOut} />}
          {page === "admins" && <AdminsSection user={user} />}
          {["brands", "shops"].includes(page) && <CatalogSection mode={page} catalog={catalog} reload={loadCatalog} brandFilter={brandFilter} setBrandFilter={setBrandFilter} viewBranches={(id) => { setBrandFilter(id); go("shops"); }} />}
        </div>
      </main>
    </div>
  );
}

function pageTitle(p) {
  const map = { dash: "แดชบอร์ด", brands: "แบรนด์และแพ็กเกจ", shops: "ร้านและสาขา", line: "การเชื่อมต่อ LINE", security: "ความปลอดภัยและกุญแจ", admins: "ผู้ดูแลแพลตฟอร์ม" };
  return map[p] || p;
}

function Dashboard({ data, catalog, go }) {
  const missing = data?.settings?.filter((setting) => !configured(setting)) || [];
  const secret = data?.settings?.find((setting) => setting.key === "line.messaging_channel_secret");
  const token = data?.settings?.find((setting) => setting.key === "line.messaging_access_token");
  const count = (key) => catalog && !catalog.error && Array.isArray(catalog[key]) ? catalog[key].length : "—";
  return <>
    {missing.length > 0 && <div className="super-todo"><span>⚠ ยังไม่ได้ตั้งค่า LINE: {missing.map((setting) => setting.label).join(", ")}</span><button className="super-btn" onClick={() => go("line")}>ไปตั้งค่า</button></div>}
    {catalog?.error && <p className="ad-error" role="alert">โหลดข้อมูลแบรนด์และร้านไม่ได้: {catalog.error}</p>}
    <div className="super-kpis">
      <div className="super-kpi"><small>แบรนด์</small><strong>{count("brands")}</strong><em>{catalog ? "จากรายการแบรนด์" : "กำลังโหลด…"}</em></div>
      <div className="super-kpi"><small>ร้านและสาขา</small><strong>{count("shops")}</strong><em>{catalog ? "จากรายการร้าน" : "กำลังโหลด…"}</em></div>
      <div className="super-kpi"><small>การจองวันนี้</small><strong>—</strong><em>ยังไม่มีข้อมูลสรุป</em></div>
      <div className="super-kpi"><small>ลูกค้าที่ผูก LINE</small><strong>—</strong><em>ยังไม่มีข้อมูลสรุป</em></div>
    </div>
    <div className="super-two">
      <section className="super-card"><h3>สถานะการตั้งค่า</h3><p className="super-sub">การตั้งค่าไม่ใช่ผลตรวจสุขภาพหรือการเชื่อมต่อ</p>
        <div className="super-li"><span className="super-ico info" aria-hidden="true">?</span><div className="super-t">ฐานข้อมูล booking-v2<small>ยังไม่มีผลตรวจสุขภาพฐานข้อมูล</small></div></div>
        <div className="super-li"><span className="super-ico info" aria-hidden="true">i</span><div className="super-t">Channel access token<small>{token ? SOURCE[token.source] : "ไม่ทราบสถานะ"} · ยังไม่ยืนยันกับ LINE</small></div></div>
        <div className="super-li"><span className={"super-ico " + (configured(secret) ? "info" : "warn")} aria-hidden="true">i</span><div className="super-t">Channel secret<small>{secret ? SOURCE[secret.source] : "ไม่ทราบสถานะ"}</small></div></div>
        <div className="super-li"><span className={"super-ico " + (data?.encryptionReady ? "ok" : "warn")} aria-hidden="true">i</span><div className="super-t">กุญแจเข้ารหัส<small>{data?.encryptionReady ? "ตั้งไว้ที่เซิร์ฟเวอร์แล้ว" : "ยังไม่ได้ตั้ง"}</small></div></div>
      </section>
      <section className="super-card"><h3>กิจกรรมล่าสุด</h3><p className="super-sub">ยังไม่มีข้อมูลประวัติกิจกรรมในหน้านี้</p><p className="super-muted">ไม่สามารถสรุปว่าใครเปลี่ยนค่าอะไรจากค่าตั้งปัจจุบันได้</p></section>
    </div>
  </>;
}

function LineSection({ data, error, load }) {
  if (error) return <p className="ad-error">{error}</p>;
  if (!data) return <p className="ad-muted">กำลังโหลด…</p>;
  return (
    <>
      <div className="super-steps">
        {data.settings.map((s, i) => (
          <div key={s.key} className={"super-step" + (s.source === "none" ? " todo" : "")}>
            <span className="super-n">{s.source === "none" ? i + 1 : "✓"}</span>
            <div>{s.label}<small>{s.source === "none" ? "ยังไม่ได้ตั้ง" : (s.source === "environment" ? SOURCE.environment : (s.secret ? s.hint : s.value))}</small></div>
          </div>
        ))}
      </div>
      {!data.encryptionReady && (
        <p className="ad-notice">ยังไม่ได้ตั้ง <code>SETTINGS_ENCRYPTION_KEY</code> (อย่างน้อย 32 ตัวอักษร) บน Railway จึงบันทึกค่าที่เป็นความลับไม่ได้</p>
      )}
      {data.settings.map((setting) => (
        <SettingCard key={setting.key} setting={setting} canSaveSecret={data.encryptionReady} onChanged={load} />
      ))}
      <TestToken />
    </>
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
    setBusy(true); setError(""); setDone("");
    try {
      await api("PUT", "/api/super/settings", { key: setting.key, value });
      setValue(""); setDone("บันทึกแล้ว");
      await onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!window.confirm(`ลบค่า ${setting.label} ที่ตั้งไว้ที่นี่?`)) return;
    setBusy(true); setError(""); setDone("");
    try {
      await api("DELETE", "/api/super/settings", { key: setting.key });
      await onChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <form className="super-card" onSubmit={save} autoComplete="off">
      <div className="super-row">
        <strong>{setting.label}</strong>
        <span className={"super-status " + TONE[setting.source]}>{SOURCE[setting.source]}</span>
      </div>
      <p className="super-muted">{setting.help}</p>
      {setting.source === "database" && (
        <p className="super-muted">ค่าปัจจุบัน: <code>{setting.secret ? setting.hint : setting.value}</code></p>
      )}
      <label className="super-field">
        <span>{setting.source === "database" ? "เปลี่ยนเป็น" : "ค่าใหม่"}</span>
        <input type={setting.secret ? "password" : "text"} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} disabled={busy || blocked} placeholder={setting.secret ? "วางค่าลับที่นี่ (บันทึกแล้วจะไม่แสดงอีก)" : ""} />
      </label>
      {error && <p role="alert" className="ad-error">{error}</p>}
      {done && <p role="status" className="super-muted">{done}</p>}
      <div className="super-row">
        <button className="super-btn" disabled={busy || blocked || !value.trim()}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
        {setting.source === "database" && (
          <button type="button" className="super-link" onClick={clear} disabled={busy}>ลบค่าที่ตั้งไว้</button>
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
    setBusy(true); setResult(""); setError("");
    try {
      const info = await api("POST", "/api/super/settings/test", {});
      setResult(`เชื่อมต่อได้: ${info.name ?? "(ไม่มีชื่อ)"}${info.basicId ? ` · ${info.basicId}` : ""}`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="super-card">
      <strong>ทดสอบการเชื่อมต่อ</strong>
      <p className="super-muted">ถาม LINE ว่า Channel access token ที่ใช้อยู่ใช้งานได้ไหม (ไม่ได้ส่งข้อความหาใคร)</p>
      {error && <p role="alert" className="ad-error">{error}</p>}
      {result && <p role="status" className="super-notice">{result}</p>}
      <button type="button" className="super-btn2" onClick={test} disabled={busy}>{busy ? "กำลังทดสอบ…" : "ทดสอบ token"}</button>
    </section>
  );
}

function SecuritySection({ data, signOut, signingOut }) {
  return (
    <div className="super-two">
      <section className="super-card">
        <h3>กุญแจเข้ารหัส <span className={"super-status " + (data?.encryptionReady ? "ok" : "warn")}>{data?.encryptionReady ? "พร้อมใช้" : "ยังไม่ได้ตั้ง"}</span></h3>
        <p className="super-sub"><code>SETTINGS_ENCRYPTION_KEY</code> ตั้งไว้ที่ Railway</p>
        <div className="super-kv"><span>ความยาว</span><span>{data?.encryptionReady ? "อย่างน้อย 32 ตัวอักษร" : "—"}</span></div>
        <div className="super-kv"><span>ค่าลับที่เก็บอยู่</span><span>{data?.settings?.filter((s) => s.source === "database" && s.secret).length ?? 0} ค่า</span></div>
        <div className="super-warnbox">ถ้ากุญแจหาย ค่าลับที่เก็บไว้จะถอดไม่ได้ ต้องกรอกใหม่ · เก็บสำรองไว้ในที่ปลอดภัย</div>
      </section>
      <section className="super-card">
        <h3>เซสชันของฉัน</h3>
        <p className="super-sub">ล็อกอินร่วมกับหน้าจัดการร้าน</p>
        <div className="super-kv"><span>สิทธิ์</span><span>ผู้ดูแลแพลตฟอร์ม</span></div>
        <div style={{ marginTop: 12 }}><button className="super-btn2" style={{ width: "100%" }} onClick={signOut} disabled={signingOut}>{signingOut ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}</button></div>
      </section>
    </div>
  );
}

function AdminsSection({ user }) {
  return <section className="super-card">
    <h3>บัญชีที่กำลังใช้งาน</h3>
    <p className="super-sub">{user.email}</p>
    <p className="super-muted">บัญชีนี้ผ่านการตรวจสอบสิทธิ์ผู้ดูแลแพลตฟอร์มแล้ว · หน้านี้ยังไม่แสดงรายชื่อผู้ดูแลทั้งหมด และยังเพิ่มหรือลบผู้ดูแลไม่ได้</p>
  </section>;
}
