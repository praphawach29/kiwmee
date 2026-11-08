"use client";

// /dashboard/wallet — แพ็กเกจและการชำระเงินของแบรนด์ (ลิงก์จากหน้าแรกแดชบอร์ด `?brand=<id>`)
// เนื้อหาเดียวกับแท็บ "แพ็กเกจและการชำระเงิน" ในหน้าร้าน (app/dashboard/billing-panel.jsx)

import { useEffect, useState } from "react";
import { api } from "../api.mjs";
import BillingPanel from "../billing-panel.jsx";

export default function WalletClient() {
  const [user, setUser] = useState(undefined);
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api("GET", "/api/dashboard/session").then((data) => setUser(data.user), () => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    api("GET", "/api/dashboard/brands")
      .then((list) => {
        const own = list.filter((b) => b.owner);
        setBrands(own);
        const asked = new URLSearchParams(window.location.search).get("brand");
        setBrandId(own.some((b) => b.id === asked) ? asked : own[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, [user]);

  const brand = brands.find((b) => b.id === brandId);
  return (
    <div className="merchant-layout bl-standalone">
      <main className="ad-shell merchant-content">
        <a className="ad-link" href="/dashboard">← ร้านทั้งหมด</a>
        <div className="merchant-page-heading">
          <div><p>{brand?.name ?? "แบรนด์"}</p><h1>แพ็กเกจและการชำระเงิน</h1></div>
          {brands.length > 1 && (
            <label className="ad-field">
              แบรนด์
              <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {user === undefined && <p className="ad-muted">กำลังโหลด…</p>}
        {user === null && <section className="ad-card"><p>ต้องเข้าสู่ระบบก่อน</p><a className="ad-primary" href="/dashboard">เข้าสู่ระบบ</a></section>}
        {error && <p className="ad-error" role="alert">{error}</p>}
        {user && !error && brands.length === 0 && <p className="ad-muted">ไม่พบแบรนด์ที่คุณเป็นเจ้าของ</p>}
        {user && brandId && <BillingPanel key={brandId} brandId={brandId} />}
      </main>
    </div>
  );
}
