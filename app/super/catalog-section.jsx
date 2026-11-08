"use client";

import { useEffect, useRef, useState } from "react";
import { filterBrands, filterShops, bookingPath, planName, kindName, brandStatus, PLAN_NAMES, KIND_NAMES, STATUS_NAMES } from "./catalog-view.mjs";
import { api } from "../dashboard/api.mjs";

const READ_ONLY = "ดูอย่างเดียว · แก้ไขข้อมูลร้านหรือเข้าสู่ระบบแทนร้านไม่ได้";
const BRAND_NOTE = "เปิดรายละเอียดแบรนด์เพื่อตั้งแพ็กเกจหรือปรับยอดกระเป๋า · ทุกการแก้ต้องใส่เหตุผล และเก็บไว้ในประวัติ";
const display = (value) => value === null || value === undefined || value === "" ? "ไม่ระบุ" : String(value);

export default function CatalogSection({ mode, catalog, reload, brandFilter, setBrandFilter, viewBranches }) {
  const [brandQuery, setBrandQuery] = useState("");
  const [shopQuery, setShopQuery] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [selected, setSelected] = useState(null);
  const brands = catalog?.brands || [];
  const shops = catalog?.shops || [];
  const isBrands = mode === "brands";
  const rows = isBrands ? filterBrands(brands, { query: brandQuery, plan, status }) : filterShops(shops, { query: shopQuery, kind, brandId: brandFilter });
  function reset() {
    if (isBrands) { setBrandQuery(""); setPlan(""); setStatus(""); }
    else { setShopQuery(""); setKind(""); setBrandFilter(""); }
  }
  function branches(id) {
    setShopQuery(""); setKind(""); setSelected(null); viewBranches(id);
  }
  if (!catalog) return <p role="status" className="super-muted">กำลังโหลดแบรนด์และร้าน…</p>;
  if (catalog.error) return <section className="super-card"><p role="alert" className="ad-error">โหลดข้อมูลแบรนด์และร้านไม่ได้: {catalog.error}</p><button className="super-btn2" onClick={reload}>ลองโหลดใหม่</button></section>;
  return <section className="super-card super-catalog">
    <h2>{isBrands ? "แบรนด์และแพ็กเกจ" : "ร้านและสาขา"}</h2>
    <p className="super-muted">{isBrands ? BRAND_NOTE : READ_ONLY}</p>
    <div className="super-filters">
      <label className="super-field super-search"><span>{isBrands ? "ค้นหาแบรนด์ / อีเมลเจ้าของ / รหัส" : "ค้นหาร้าน / slug / แบรนด์ / รหัส"}</span><input type="search" value={isBrands ? brandQuery : shopQuery} onChange={(e) => isBrands ? setBrandQuery(e.target.value) : setShopQuery(e.target.value)} /></label>
      {isBrands ? <label className="super-field"><span>แพ็กเกจ</span><select aria-label="แพ็กเกจ" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">ทุกแพ็กเกจ</option>{[...new Set([...Object.keys(PLAN_NAMES), ...brands.map((b) => b.plan).filter(Boolean)])].map((value) => <option key={value} value={value}>{planName(value)}</option>)}</select></label> : <>
        <label className="super-field"><span>ประเภทกิจการ</span><select aria-label="ประเภทกิจการ" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">ทุกประเภท</option>{[...new Set([...Object.keys(KIND_NAMES), ...shops.map((s) => s.kind).filter(Boolean)])].map((value) => <option key={value} value={value}>{kindName(value)}</option>)}</select></label>
        <label className="super-field"><span>แบรนด์</span><select aria-label="แบรนด์" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}><option value="">ทุกแบรนด์</option><option value="unassigned">ไม่ผูกแบรนด์</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      </>}
      {isBrands && <label className="super-field"><span>สถานะ</span><select aria-label="สถานะแพ็กเกจ" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">ทุกสถานะ</option>{Object.entries(STATUS_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
      <button className="super-btn2" onClick={reset}>ล้างตัวกรอง</button>
    </div>
    <p role="status" className="super-muted">พบ {rows.length} จาก {isBrands ? brands.length : shops.length} {isBrands ? "แบรนด์" : "ร้าน"}</p>
    {rows.length ? <div className="super-tbl"><table className="super-catalog-table"><caption className="super-visually-hidden">{isBrands ? "รายชื่อแบรนด์" : "รายชื่อร้านและสาขา"}</caption><thead><tr><th scope="col">{isBrands ? "แบรนด์ / เจ้าของ" : "ร้าน / ลิงก์จอง"}</th><th scope="col">{isBrands ? "สาขา" : "แบรนด์"}</th><th scope="col">{isBrands ? "แพ็กเกจ" : "ประเภท"}</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}>
        <td data-label={isBrands ? "แบรนด์ / เจ้าของ" : "ร้าน / ลิงก์จอง"}><button className="super-record-link" aria-haspopup="dialog" onClick={() => setSelected({ type: mode, record: row })}>{row.name}</button><small>{isBrands ? display(row.ownerEmail) : <code>/b/{row.slug}</code>}</small></td>
        <td data-label={isBrands ? "สาขา" : "แบรนด์"}>{isBrands ? <button className="super-record-link" onClick={() => branches(row.id)} aria-label={`ดูสาขาของ ${row.name}`}>{display(row.branchCount)} / {display(row.branchLimit)}</button> : row.brandId && brands.some((b) => b.id === row.brandId) ? <button className="super-record-link" aria-haspopup="dialog" onClick={() => setSelected({ type: "brands", record: brands.find((b) => b.id === row.brandId) })}>{row.brandName || "ดูแบรนด์"}</button> : display(row.brandName)}</td>
        <td data-label={isBrands ? "แพ็กเกจ" : "ประเภท"}>{isBrands ? <><span className="super-pill2 info">{planName(row.plan)}</span> <small className={`super-plan-status ${brandStatus(row).tone}`}>{brandStatus(row).label}</small></> : kindName(row.kind)}</td>
      </tr>)}
    </tbody></table></div> : <p className="super-empty">{(isBrands ? brands : shops).length ? "ไม่พบข้อมูลที่ตรงกับตัวกรอง ลองเปลี่ยนคำค้นหาหรือล้างตัวกรอง" : isBrands ? "ยังไม่มีแบรนด์ในระบบ" : "ยังไม่มีร้านในระบบ"}</p>}
    {selected && <CatalogDetail selected={selected} brands={brands} shops={shops} close={() => setSelected(null)} select={setSelected} viewBranches={branches} reload={reload} />}
  </section>;
}

function CatalogDetail({ selected, brands, shops, close, select, viewBranches, reload }) {
  const dialog = useRef(null);
  const isBrand = selected.type === "brands";
  const record = selected.record;
  const branchShops = shops.filter((shop) => shop.brandId === record.id);
  const brand = !isBrand && brands.find((item) => item.id === record.brandId);
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement;
    node.showModal();
    return () => { node.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const fields = isBrand ? [
    ["รหัสแบรนด์", record.id], ["ชื่อแบรนด์", record.name], ["อีเมลเจ้าของ", record.ownerEmail], ["แพ็กเกจ", planName(record.plan)], ["จำนวนสาขา", record.branchCount], ["เพดานสาขาตามข้อมูลระบบ", record.branchLimit],
  ] : [["รหัสร้าน", record.id], ["ชื่อร้าน", record.name], ["Slug", record.slug], ["ประเภทกิจการ", kindName(record.kind)], ["แบรนด์", record.brandName], ["รหัสแบรนด์", record.brandId]];
  return <dialog ref={dialog} className="super-detail" aria-labelledby="super-detail-title" aria-describedby="super-detail-description" onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
    <header className="super-detail-head"><div><p className="super-muted">{isBrand ? "รายละเอียดแบรนด์" : "รายละเอียดร้าน"}</p><h2 id="super-detail-title">{record.name}</h2></div><button autoFocus className="super-btn2" aria-label="ปิดรายละเอียด" onClick={close}>✕ ปิด</button></header>
    <p id="super-detail-description" className="super-muted">{isBrand ? BRAND_NOTE : READ_ONLY}</p>
    <dl className="super-detail-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>
    {isBrand && <BrandBilling key={record.id} brandId={record.id} onChanged={reload} />}
    {isBrand ? <section><h3>สาขาของแบรนด์นี้</h3><p className="super-muted">พบ {branchShops.length} ร้านในรายการที่โหลด</p>{branchShops.length ? <ul className="super-branch-list">{branchShops.map((shop) => <li key={shop.id}><button className="super-record-link" onClick={() => select({ type: "shops", record: shop })}>{shop.name}</button><small>{kindName(shop.kind)} · /b/{shop.slug}</small></li>)}</ul> : <p className="super-muted">ไม่มีสาขาในรายการที่โหลด</p>}<button className="super-btn2" onClick={() => viewBranches(record.id)}>ดูรายการสาขาทั้งหมดของแบรนด์นี้</button></section> : <>
      {brand && <p><button className="super-record-link" onClick={() => select({ type: "brands", record: brand })}>ดูรายละเอียดแบรนด์ {brand.name}</button></p>}
      <BookingActions key={record.id} slug={record.slug} />
    </>}
  </dialog>;
}

function BookingActions({ slug }) {
  const [message, setMessage] = useState("");
  const [copyError, setCopyError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = bookingPath(slug);
  async function copy() {
    setBusy(true); setMessage(""); setCopyError("");
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setMessage("คัดลอกลิงก์จองแล้ว");
    } catch { setCopyError("คัดลอกไม่ได้ กรุณาเลือกลิงก์ด้านล่างแล้วคัดลอกเอง"); }
    finally { setBusy(false); }
  }
  return <section className="super-booking-actions"><h3>ลิงก์จองสำหรับลูกค้า</h3><p className="super-muted">ลิงก์สาธารณะของร้าน ไม่ใช่ลิงก์จัดการการจองหรือเซสชันร้าน</p>{path ? <>
    <p><a className="super-record-link" href={path} target="_blank" rel="noopener noreferrer">{path}</a></p>
    <div className="super-row"><a className="super-btn" href={path} target="_blank" rel="noopener noreferrer">เปิดหน้าจอง ↗ <span className="super-visually-hidden">(แท็บใหม่)</span></a><button className="super-btn2" onClick={copy} disabled={busy}>{busy ? "กำลังคัดลอก…" : "คัดลอกลิงก์จอง"}</button></div>
    {message && <p role="status" className="super-notice">{message}</p>}{copyError && <p role="alert" className="ad-error">{copyError}</p>}
  </> : <p className="super-muted">ไม่มี slug จึงยังเปิดลิงก์จองไม่ได้</p>}</section>;
}

// ---------- B7: plan and wallet of one brand ----------
const DAY_MS = 864e5;
const bkkDate = (value) => (value ? new Date(new Date(value).getTime() + 7 * 3600e3).toISOString().slice(0, 10) : "");
const thTime = (value) => new Date(value).toLocaleString("th-TH", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const money = (n) => Number(n ?? 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const plusDays = (from, days) => bkkDate(new Date(Math.max(Date.now(), from ? new Date(from).getTime() : 0) + days * DAY_MS));

export function BrandBilling({ brandId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ plan: "pro", validUntil: "", complimentary: true, reason: "" });
  const [wallet, setWallet] = useState({ amount: "", reason: "" });

  async function load() {
    try {
      const d = await api("POST", "/api/super/brands", { action: "detail", brandId });
      setData(d);
      setForm((f) => ({ ...f, plan: d.plan?.plan ?? "free", validUntil: bkkDate(d.plan?.valid_until), complimentary: d.plan?.complimentary === true }));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { load(); }, [brandId]);

  async function run(body, done) {
    setBusy(true); setError(""); setNotice("");
    try {
      await api("POST", "/api/super/brands", { brandId, ...body });
      setNotice(done);
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const savePlan = async (event) => {
    event.preventDefault();
    if (await run({ action: "set_plan", plan: form.plan, validUntil: form.plan === "free" ? null : form.validUntil || null, complimentary: form.complimentary, reason: form.reason }, "บันทึกแพ็กเกจแล้ว")) setForm((f) => ({ ...f, reason: "" }));
  };
  const saveWallet = async (event) => {
    event.preventDefault();
    if (await run({ action: "adjust_wallet", amount: Number(wallet.amount), reason: wallet.reason }, "ปรับยอดกระเป๋าแล้ว")) setWallet({ amount: "", reason: "" });
  };

  if (!data) return <section className="super-billing"><h3>แพ็กเกจและกระเป๋าเงิน</h3>{error ? <p role="alert" className="ad-error">{error}</p> : <p className="super-muted">กำลังโหลด…</p>}</section>;
  const p = data.plan ?? {};
  const presets = [
    ["โปรฟรี 14 วัน", { plan: "pro", validUntil: plusDays(null, 14), complimentary: true }],
    ["ต่อแพ็กเกจเดิม 30 วัน", { plan: p.plan === "free" ? "pro" : p.plan, validUntil: plusDays(p.valid_until, 30), complimentary: p.complimentary === true }],
    ["กลับเป็นฟรี", { plan: "free", validUntil: "", complimentary: false }]
  ];
  const facts = [
    ["แพ็กเกจที่ใช้อยู่", `${planName(p.effective)}${p.plan !== p.effective ? ` (บันทึกไว้: ${planName(p.plan)})` : ""}`],
    ["หมดอายุ", p.valid_until ? thTime(p.valid_until) : "ไม่หมดอายุ"],
    ["ประเภท", p.trial ? "ทดลองใช้" : p.complimentary ? "ให้ใช้ฟรี" : p.plan === "free" ? "ฟรี" : `จ่ายเงิน · ${p.cycle === "year" ? "รายปี" : "รายเดือน"}`],
    ["ต่ออายุอัตโนมัติ", p.complimentary || p.plan === "free" ? "—" : p.auto_renew ? "เปิด" : "ปิด"],
    ["รอบหน้า", p.next_plan ? planName(p.next_plan) : "—"],
    ["ผ่อนผันถึง", p.grace_until ? thTime(p.grace_until) : "—"],
    ["ยอดกระเป๋า", `${money(data.balance)} บาท`],
    ["สิทธิ์ทดลองของเจ้าของ", data.trialUsedAt ? `ใช้แล้ว ${thTime(data.trialUsedAt)}` : "ยังไม่ใช้"]
  ];
  return (
    <section className="super-billing" aria-label="แพ็กเกจและกระเป๋าเงิน">
      <h3>แพ็กเกจและกระเป๋าเงิน</h3>
      <dl className="super-detail-fields">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {notice && <p role="status" className="super-notice">{notice}</p>}
      {error && <p role="alert" className="ad-error">{error}</p>}

      <form className="super-billing-form" onSubmit={savePlan}>
        <h4>ตั้งแพ็กเกจ</h4>
        <div className="super-row">{presets.map(([label, value]) => <button key={label} type="button" className="super-btn2" onClick={() => setForm((f) => ({ ...f, ...value }))}>{label}</button>)}</div>
        <div className="super-billing-grid">
          <label className="super-field"><span>แพ็กเกจ</span><select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>{Object.keys(PLAN_NAMES).map((k) => <option key={k} value={k}>{planName(k)}</option>)}</select></label>
          <label className="super-field"><span>ใช้ได้ถึง (เวลาไทย สิ้นวัน)</span><input type="date" value={form.plan === "free" ? "" : form.validUntil} disabled={form.plan === "free"} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /><small className="super-muted">{form.plan === "free" ? "แพ็กเกจฟรีไม่มีวันหมดอายุ" : form.validUntil ? `= ${new Date(`${form.validUntil}T12:00:00+07:00`).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" })} เวลา 23:59 น.` : "เว้นว่าง = ไม่หมดอายุ"}</small></label>
          <label className="super-check"><input type="checkbox" checked={form.plan !== "free" && form.complimentary} disabled={form.plan === "free"} onChange={(e) => setForm({ ...form, complimentary: e.target.checked })} />ให้ใช้ฟรี (ไม่ตัดเงิน ไม่ต่ออายุจากกระเป๋า)</label>
        </div>
        <label className="super-field"><span>เหตุผล (เก็บในประวัติ)</span><input required minLength={3} maxLength={300} value={form.reason} placeholder="เช่น ชดเชยระบบล่ม 2 วัน / ร้านพาร์ตเนอร์" onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <p className="super-muted">บันทึกแล้ว ทดลอง/ผ่อนผัน/รอบหน้าถูกล้าง และระบบพักหรือเปิดฟีเจอร์ตามแพ็กเกจใหม่ทันที</p>
        <button className="super-btn" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกแพ็กเกจ"}</button>
      </form>

      <form className="super-billing-form" onSubmit={saveWallet}>
        <h4>ปรับยอดกระเป๋า</h4>
        <div className="super-billing-grid">
          <label className="super-field"><span>จำนวน (บาท · ติดลบ = หักออก)</span><input type="number" step="0.01" required value={wallet.amount} placeholder="เช่น 500 หรือ -100" onChange={(e) => setWallet({ ...wallet, amount: e.target.value })} /></label>
          <label className="super-field"><span>เหตุผล (ร้านเห็นในประวัติการเงิน)</span><input required minLength={3} maxLength={300} value={wallet.reason} placeholder="เช่น โอนแล้วสลิปอ่านไม่ได้" onChange={(e) => setWallet({ ...wallet, reason: e.target.value })} /></label>
        </div>
        <button className="super-btn" disabled={busy}>{busy ? "กำลังบันทึก…" : "ปรับยอด"}</button>
      </form>

      <h4>ประวัติการแก้โดยทีมงาน</h4>
      {data.changes.length === 0 ? <p className="super-muted">ยังไม่มี</p> : (
        <ul className="super-history">{data.changes.map((c, i) => (
          <li key={i}><strong>{c.action === "set_plan" ? `ตั้งแพ็กเกจ ${planName(c.detail?.after?.plan)}${c.detail?.after?.valid_until ? ` ถึง ${thTime(c.detail.after.valid_until)}` : ""}` : `ปรับยอด ${c.detail?.amount > 0 ? "+" : ""}${money(c.detail?.amount)} บาท`}</strong><small>{thTime(c.created_at)} · {c.admin_email ?? "ทีมงาน"} · {c.reason}</small></li>
        ))}</ul>
      )}
      <h4>รายการเงินล่าสุด</h4>
      {data.entries.length === 0 ? <p className="super-muted">ยังไม่มี</p> : (
        <ul className="super-history">{data.entries.map((e, i) => (
          <li key={i}><strong>{e.amount > 0 ? "+" : ""}{money(e.amount)} บาท · {e.note ?? e.kind}</strong><small>{thTime(e.created_at)} · คงเหลือ {money(e.balance_after)}</small></li>
        ))}</ul>
      )}
    </section>
  );
}
