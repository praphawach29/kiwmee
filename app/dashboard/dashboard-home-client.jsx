"use client";

// /dashboard: sign in (or sign up, or reset the password) with Supabase Auth, then pick one of your
// shops or open a new one. Links from Supabase's emails land here with the session in the URL hash.

import { useCallback, useEffect, useState } from "react";
import { api, supabaseAuth } from "./api.mjs";
import MerchantSidebar from "./merchant-sidebar.jsx";

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

  const workspace = Boolean(auth && user && !recoveryToken);
  return (
    <div className={workspace ? "merchant-layout merchant-home" : "merchant-auth"}>
      {workspace && <MerchantSidebar
        groups={[
          { label: "ภาพรวม", items: [{ id: "shops", label: "แบรนด์และสาขา", icon: "⌂", href: "#merchant-shops" }] },
          { label: "จัดการร้าน", items: [{ id: "create", label: "เปิดร้าน / แบรนด์ใหม่", icon: "+", href: "#merchant-create" }] },
        ]}
        active="shops" name={user.email} role="บัญชีจัดการร้าน" onSignOut={signOut}
      />}
      <div className="merchant-main">
        {workspace && <header className="merchant-topbar"><div className="merchant-breadcrumb">พื้นที่จัดการร้าน<span>/</span><b>แบรนด์และสาขา</b></div><span className="merchant-account">{user.email}</span></header>}
        <main className={"ad-shell " + (workspace ? "merchant-content" : "ad-narrow")}>
          {workspace && <div className="merchant-page-heading"><div><p>พื้นที่จัดการร้านของคุณ</p><h1>แบรนด์และสาขา</h1><p>เลือกร้านเพื่อจัดการการจอง บิล และการตั้งค่า</p></div></div>}
      <header className={"ad-header" + (workspace ? " merchant-mobile-header" : "")}>
        <a href="/" className="ad-brand" aria-label="Kiwmee หน้าแรก"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" /></a>
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
      </div>
    </div>
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

// Your brands, each with its branches (docs/LOYALTY_DESIGN.md §2): add a branch set up like an
// existing one, bring a shop you already own into the brand, or open a new brand.
function Shops() {
  const [brands, setBrands] = useState(null);
  const [form, setForm] = useState({ name: "", slug: "", kind: "salon" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api("GET", "/api/dashboard/brands").then(setBrands, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

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

  if (!brands) return <p className={error ? "ad-error" : "ad-muted"}>{error || "กำลังโหลด…"}</p>;
  const hasShops = brands.some((b) => b.shops.length > 0);
  return (
    <div id="merchant-shops" className="merchant-shops ad-stack">
      {brands.map((b) => (
        <BrandCard key={b.id} brand={b} brands={brands} onChanged={load} />
      ))}
      <form id="merchant-create" className="ad-card merchant-create" onSubmit={create}>
        <h2>{hasShops ? "เปิดแบรนด์ใหม่" : "เริ่มจากเปิดร้านของคุณ"}</h2>
        {hasShops && <p className="ad-muted">ร้านที่ไม่เกี่ยวกับแบรนด์เดิม · ถ้าเป็นสาขาของแบรนด์เดิม ใช้ "เพิ่มสาขา" ด้านบน</p>}
        <label className="ad-field">
          ชื่อร้าน
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <SlugField value={form.slug} onChange={(slug) => setForm({ ...form, slug })} />
        <label className="ad-field">
          ประเภทร้าน
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(SHOP_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {error && <p className="ad-error">{error}</p>}
        <button className="ad-primary" disabled={busy}>เปิดร้าน</button>
      </form>
    </div>
  );
}

function SlugField({ value, onChange }) {
  return (
    <label className="ad-field">
      ชื่อลิงก์หน้าจอง (a-z, 0-9, -)
      <span className="ad-inline">
        <span className="ad-muted">/b/</span>
        <input required pattern="[a-z0-9][a-z0-9\-]{1,40}" value={value} onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
      </span>
    </label>
  );
}

function BrandCard({ brand, brands, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const full = brand.branchCount >= brand.branchLimit;
  // shops you own in your other brands, which you could bring into this one
  const movable = brand.owner
    ? brands.filter((o) => o.id !== brand.id && o.owner).flatMap((o) => o.shops.filter((s) => s.role === "owner"))
    : [];

  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function rename() {
    const name = window.prompt("ชื่อแบรนด์", brand.name);
    if (name && name.trim() && name.trim() !== brand.name) run(() => api("PUT", `/api/dashboard/brands/${brand.id}`, { name }));
  }

  function moveIn(slug) {
    const shop = movable.find((s) => s.slug === slug);
    if (shop && window.confirm(`ย้าย "${shop.name}" เข้าแบรนด์ ${brand.name}? คะแนนสะสมของลูกค้าจะใช้ร่วมกับสาขาอื่นในแบรนด์นี้`)) {
      run(() => api("POST", `/api/dashboard/brands/${brand.id}/shops`, { slug }));
    }
  }

  return (
    <section className="ad-card">
      <div className="ad-row ad-wrap ad-between">
        <div className="ad-row ad-wrap">
          <h2>{brand.name}</h2>
          {brand.owner && <button type="button" className="ad-link" onClick={rename} disabled={busy}>เปลี่ยนชื่อ</button>}
        </div>
        <span className="ad-status" data-tone="info">แพ็กเกจ{brand.planName} · {brand.branchCount}/{brand.branchLimit} สาขา</span>
      </div>
      <ul className="ad-list">
        {brand.shops.map((s) => (
          <li key={s.slug}>
            <a className="ad-list-item" href={`/dashboard/${s.slug}`}>
              <strong>{s.name}</strong>
              <span className="ad-muted">{SHOP_KINDS[s.kind] ?? s.kind} · {ROLE[s.role]}</span>
            </a>
          </li>
        ))}
      </ul>
      {brand.owner && !adding && (
        <div className="ad-row ad-wrap">
          <button type="button" className="ad-secondary" disabled={busy || full} onClick={() => setAdding(true)}>+ เพิ่มสาขา</button>
          {!full && movable.length > 0 && (
            <select value="" onChange={(e) => moveIn(e.target.value)} disabled={busy} aria-label="ย้ายร้านเข้าแบรนด์นี้">
              <option value="">ย้ายร้านที่มีอยู่เข้าแบรนด์นี้…</option>
              {movable.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
            </select>
          )}
        </div>
      )}
      {brand.owner && full && <p className="ad-muted">แพ็กเกจ{brand.planName}มีได้ {brand.branchLimit} สาขา · อัปเกรดเป็นแพ็กเกจโปรเพื่อเพิ่มสาขาและใช้คะแนนร่วมกันทุกสาขา</p>}
      {adding && <BranchForm brand={brand} onClose={() => setAdding(false)} />}
      {error && <p className="ad-error">{error}</p>}
    </section>
  );
}

function BranchForm({ brand, onClose }) {
  const [f, setF] = useState({ name: `${brand.name} สาขา ${brand.branchCount + 1}`, slug: "", copyFrom: brand.shops[0]?.slug ?? "", copyResources: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { slug } = await api("POST", `/api/dashboard/brands/${brand.id}/branches`, { ...f, copyFrom: f.copyFrom || undefined });
      window.location.href = `/dashboard/${slug}`;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <form className="ad-stack" onSubmit={submit}>
      <h3>เพิ่มสาขา</h3>
      <label className="ad-field">
        ชื่อสาขา
        <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <SlugField value={f.slug} onChange={(slug) => setF({ ...f, slug })} />
      <label className="ad-field">
        ตั้งค่าเหมือนสาขา
        <select value={f.copyFrom} onChange={(e) => setF({ ...f, copyFrom: e.target.value })}>
          {brand.shops.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
          <option value="">ไม่คัดลอก (เริ่มว่าง)</option>
        </select>
      </label>
      {f.copyFrom && (
        <>
          <p className="ad-muted">คัดลอก: บริการและราคา · ขั้นตอนจอง · เวลาทำการ · กติกาการจอง (ไม่รวมการจอง ลูกค้า บิล และวันหยุด)</p>
          <label className="ad-check">
            <input type="checkbox" checked={f.copyResources} onChange={(e) => setF({ ...f, copyResources: e.target.checked })} />
            คัดลอกช่าง/สนามและตารางงานด้วย (เหมาะกับสนามหรือห้องที่เหมือนกันทุกสาขา)
          </label>
        </>
      )}
      {error && <p className="ad-error">{error}</p>}
      <div className="ad-row">
        <button className="ad-primary" disabled={busy}>สร้างสาขา</button>
        <button type="button" className="ad-secondary" onClick={onClose}>ยกเลิก</button>
      </div>
    </form>
  );
}
