"use client";

import { useEffect, useRef, useState } from "react";
import { filterBrands, filterShops, bookingPath, planName, kindName, PLAN_NAMES, KIND_NAMES } from "./catalog-view.mjs";

const READ_ONLY = "ดูอย่างเดียว · ยังแก้ไขข้อมูล เปลี่ยนแพ็กเกจ หรือเข้าสู่ระบบแทนร้านไม่ได้";
const display = (value) => value === null || value === undefined || value === "" ? "ไม่ระบุ" : String(value);

export default function CatalogSection({ mode, catalog, reload, brandFilter, setBrandFilter, viewBranches }) {
  const [brandQuery, setBrandQuery] = useState("");
  const [shopQuery, setShopQuery] = useState("");
  const [plan, setPlan] = useState("");
  const [kind, setKind] = useState("");
  const [selected, setSelected] = useState(null);
  const brands = catalog?.brands || [];
  const shops = catalog?.shops || [];
  const isBrands = mode === "brands";
  const rows = isBrands ? filterBrands(brands, { query: brandQuery, plan }) : filterShops(shops, { query: shopQuery, kind, brandId: brandFilter });
  function reset() {
    if (isBrands) { setBrandQuery(""); setPlan(""); }
    else { setShopQuery(""); setKind(""); setBrandFilter(""); }
  }
  function branches(id) {
    setShopQuery(""); setKind(""); setSelected(null); viewBranches(id);
  }
  if (!catalog) return <p role="status" className="super-muted">กำลังโหลดแบรนด์และร้าน…</p>;
  if (catalog.error) return <section className="super-card"><p role="alert" className="ad-error">โหลดข้อมูลแบรนด์และร้านไม่ได้: {catalog.error}</p><button className="super-btn2" onClick={reload}>ลองโหลดใหม่</button></section>;
  return <section className="super-card super-catalog">
    <h2>{isBrands ? "แบรนด์และแพ็กเกจ" : "ร้านและสาขา"}</h2>
    <p className="super-muted">{READ_ONLY}</p>
    <div className="super-filters">
      <label className="super-field super-search"><span>{isBrands ? "ค้นหาแบรนด์ / อีเมลเจ้าของ / รหัส" : "ค้นหาร้าน / slug / แบรนด์ / รหัส"}</span><input type="search" value={isBrands ? brandQuery : shopQuery} onChange={(e) => isBrands ? setBrandQuery(e.target.value) : setShopQuery(e.target.value)} /></label>
      {isBrands ? <label className="super-field"><span>แพ็กเกจ</span><select aria-label="แพ็กเกจ" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">ทุกแพ็กเกจ</option>{[...new Set([...Object.keys(PLAN_NAMES), ...brands.map((b) => b.plan).filter(Boolean)])].map((value) => <option key={value} value={value}>{planName(value)}</option>)}</select></label> : <>
        <label className="super-field"><span>ประเภทกิจการ</span><select aria-label="ประเภทกิจการ" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">ทุกประเภท</option>{[...new Set([...Object.keys(KIND_NAMES), ...shops.map((s) => s.kind).filter(Boolean)])].map((value) => <option key={value} value={value}>{kindName(value)}</option>)}</select></label>
        <label className="super-field"><span>แบรนด์</span><select aria-label="แบรนด์" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}><option value="">ทุกแบรนด์</option><option value="unassigned">ไม่ผูกแบรนด์</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      </>}
      <button className="super-btn2" onClick={reset}>ล้างตัวกรอง</button>
    </div>
    <p role="status" className="super-muted">พบ {rows.length} จาก {isBrands ? brands.length : shops.length} {isBrands ? "แบรนด์" : "ร้าน"}</p>
    {rows.length ? <div className="super-tbl"><table className="super-catalog-table"><caption className="super-visually-hidden">{isBrands ? "รายชื่อแบรนด์" : "รายชื่อร้านและสาขา"}</caption><thead><tr><th scope="col">{isBrands ? "แบรนด์ / เจ้าของ" : "ร้าน / ลิงก์จอง"}</th><th scope="col">{isBrands ? "สาขา" : "แบรนด์"}</th><th scope="col">{isBrands ? "แพ็กเกจ" : "ประเภท"}</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}>
        <td><button className="super-record-link" aria-haspopup="dialog" onClick={() => setSelected({ type: mode, record: row })}>{row.name}</button><small>{isBrands ? display(row.ownerEmail) : <code>/b/{row.slug}</code>}</small></td>
        <td>{isBrands ? <button className="super-record-link" onClick={() => branches(row.id)} aria-label={`ดูสาขาของ ${row.name}`}>{display(row.branchCount)} / {display(row.branchLimit)}</button> : row.brandId && brands.some((b) => b.id === row.brandId) ? <button className="super-record-link" aria-haspopup="dialog" onClick={() => setSelected({ type: "brands", record: brands.find((b) => b.id === row.brandId) })}>{row.brandName || "ดูแบรนด์"}</button> : display(row.brandName)}</td>
        <td>{isBrands ? <span className="super-pill2 info">{planName(row.plan)}</span> : kindName(row.kind)}</td>
      </tr>)}
    </tbody></table></div> : <p className="super-empty">{(isBrands ? brands : shops).length ? "ไม่พบข้อมูลที่ตรงกับตัวกรอง ลองเปลี่ยนคำค้นหาหรือล้างตัวกรอง" : isBrands ? "ยังไม่มีแบรนด์ในระบบ" : "ยังไม่มีร้านในระบบ"}</p>}
    {selected && <CatalogDetail selected={selected} brands={brands} shops={shops} close={() => setSelected(null)} select={setSelected} viewBranches={branches} />}
  </section>;
}

function CatalogDetail({ selected, brands, shops, close, select, viewBranches }) {
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
    <p id="super-detail-description" className="super-muted">{READ_ONLY}</p>
    <dl className="super-detail-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>
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
