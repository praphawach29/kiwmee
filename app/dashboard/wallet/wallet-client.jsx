"use client";

// กระเป๋าเงินของแบรนด์ (migration …003700): ยอดคงเหลือ เติมเงินด้วยสลิป ซื้อแพ็กเกจ/แพ็กเสริม
// ใช้คลาส CSS เดิมของแดชบอร์ดไปก่อน — หน้าตาจะถูกออกแบบจริงอีกรอบพร้อมหน้าของทั้งสาม role

import { useCallback, useEffect, useState } from "react";
import { api } from "../api.mjs";

const money = (n) => Number(n ?? 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const PRESETS = [500, 1000, 2000, 5000];

const REASON = {
  AMOUNT_LOW: "ยอดโอนน้อยกว่าที่ขอ",
  AMOUNT_HIGH: "ยอดโอนเกิน 20,000 บาท",
  RECEIVER_MISMATCH: "บัญชีผู้รับไม่ใช่บัญชีของ Kiwmee",
  RECEIVER_UNKNOWN: "ตรวจบัญชีผู้รับไม่ได้ (ยังไม่ได้ตั้งบัญชีรับเงินใน /super)",
  DUPLICATE: "สลิปนี้เคยใช้เติมเงินแล้ว",
  TOO_OLD: "สลิปเก่ากว่า 7 วัน",
  IN_FUTURE: "เวลาบนสลิปอยู่ในอนาคต",
  UNREADABLE: "อ่านสลิปไม่ได้"
};

export default function WalletClient() {
  const [user, setUser] = useState(undefined);
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState("");
  const [wallet, setWallet] = useState(null);
  const [amount, setAmount] = useState(1000);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);

  const load = useCallback(async (id) => {
    setBusy("load");
    try {
      setWallet(await api("GET", `/api/dashboard/brands/${id}/wallet`));
    } catch (error) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    api("GET", "/api/dashboard/session")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    api("GET", "/api/dashboard/brands")
      .then((list) => {
        setBrands(list);
        const asked = new URLSearchParams(window.location.search).get("brand");
        const own = list.filter((b) => b.owner);
        setBrandId(asked || own[0]?.id || list[0]?.id || "");
      })
      .catch((error) => setMessage({ kind: "error", text: error.message }));
  }, [user]);

  useEffect(() => {
    if (brandId) load(brandId);
  }, [brandId, load]);

  async function topUp(event) {
    event.preventDefault();
    setMessage(null);
    if (!file) {
      setMessage({ kind: "warn", text: "แนบรูปสลิปโอนเงินก่อน" });
      return;
    }
    setBusy("topup");
    try {
      const response = await fetch(`/api/dashboard/brands/${brandId}/wallet/topups?amount=${amount}`, {
        method: "POST",
        headers: { "content-type": file.type || "image/jpeg" },
        body: file
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "เติมเงินไม่สำเร็จ");
      const result = payload.data;
      if (result.status === "credited") {
        setMessage({ kind: "ok", text: `เติมเงินสำเร็จ ${money(result.credited)} บาท · ยอดใหม่ ${money(result.balance)} บาท` });
        setFile(null);
      } else if (result.status === "pending" && result.reasons?.length) {
        const text = result.reasons.map((r) => REASON[r] ?? r).join(" · ");
        setMessage({ kind: "warn", text: `สลิปยังไม่ผ่านการตรวจ (${text}) — เก็บไว้ให้ผู้ดูแลตรวจแล้ว` });
      } else {
        setMessage({ kind: "warn", text: "ยังไม่ได้ตรวจสลิปอัตโนมัติ (ยังไม่ตั้งคีย์ EasySlip) — รอผู้ดูแลตรวจ" });
      }
      await load(brandId);
    } catch (error) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function buy(sku, label) {
    setMessage(null);
    setBusy(sku);
    try {
      const result = await api("POST", `/api/dashboard/brands/${brandId}/wallet/orders`, { sku });
      setMessage({ kind: "ok", text: `ซื้อ ${label} แล้ว · ยอดคงเหลือ ${money(result.balance)} บาท` });
      await load(brandId);
    } catch (error) {
      setMessage({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  if (user === undefined) return <main className="ad-shell ad-narrow"><p className="ad-muted">กำลังโหลด…</p></main>;
  if (user === null) {
    return (
      <main className="ad-shell ad-narrow">
        <div className="ad-card">
          <h1>กระเป๋าเงิน</h1>
          <p className="ad-muted">ต้องเข้าสู่ระบบก่อน</p>
          <a className="ad-primary" href="/dashboard">เข้าสู่ระบบ</a>
        </div>
      </main>
    );
  }

  return (
    <main className="ad-shell">
      <header className="ad-header">
        <h1>กระเป๋าเงิน</h1>
        <p className="ad-muted">เติมเงินด้วยการโอนแล้วแนบสลิป — สลิปที่ถูกต้องเข้าอัตโนมัติ</p>
      </header>

      {message && (
        <p
          className="ad-muted"
          style={{
            color: message.kind === "error" ? "#B42318" : message.kind === "warn" ? "#B54708" : "#067647",
            fontWeight: 600
          }}
        >
          {message.text}
        </p>
      )}

      {brands.length > 1 && (
        <label className="ad-field">
          แบรนด์
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      )}

      {!wallet ? (
        <p className="ad-muted">{busy ? "กำลังโหลด…" : "ไม่พบแบรนด์ที่คุณเป็นเจ้าของ"}</p>
      ) : (
        <>
          <div className="ad-grid">
            <div className="ad-card">
              <h2>ยอดคงเหลือ</h2>
              <p style={{ fontSize: "2rem", fontWeight: 700, margin: 0 }}>{money(wallet.balance)} บาท</p>
              <p className="ad-muted">
                แพ็กเกจ: {wallet.plan.effective}
                {wallet.plan.valid_until ? ` · ถึง ${new Date(wallet.plan.valid_until).toLocaleDateString("th-TH")}` : ""}
              </p>
            </div>
            <div className="ad-card">
              <h2>โควตาเดือนนี้</h2>
              <p className="ad-muted">
                ข้อความ LINE ใช้ {money(wallet.quota.used)} / {money(wallet.quota.total)} ข้อความ
                {wallet.quota.level === "warn" ? " · ใกล้เต็มแล้ว" : ""}
                {wallet.quota.level === "full" ? " · เต็มแล้ว — การ์ด LINE หยุดส่ง (การจอง/บิลยังทำงานปกติ)" : ""}
              </p>
              <div
                role="progressbar"
                aria-valuenow={wallet.quota.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="โควตาข้อความ LINE"
                style={{ height: 8, borderRadius: 999, background: "#EDE9F7", overflow: "hidden", margin: "6px 0 10px" }}
              >
                <div
                  style={{
                    width: `${wallet.quota.percent}%`,
                    height: "100%",
                    background: wallet.quota.level === "full" ? "#B42318" : wallet.quota.level === "warn" ? "#B54708" : "#6A4CFF"
                  }}
                />
              </div>
              <p className="ad-muted">
                ตรวจสลิปอัตโนมัติใช้ {money(wallet.usage.slipsUsed)} / {money(wallet.usage.slipsPurchased)} ครั้ง
              </p>
            </div>
          </div>

          <form className="ad-card" onSubmit={topUp}>
            <h2>เติมเงิน</h2>
            <p className="ad-muted">
              โอนเข้าบัญชี: {wallet.payTo?.promptPay ? `พร้อมเพย์ ${wallet.payTo.promptPay}` : "— ยังไม่ได้ตั้งใน /super"}
              {wallet.payTo?.accountName ? ` · ${wallet.payTo.accountName}` : ""}
              {wallet.payTo?.bank ? ` · ${wallet.payTo.bank}` : ""}
            </p>
            <div className="ad-chips">
              {PRESETS.map((value) => (
                <button key={value} type="button" className="ad-chip" data-on={Number(amount) === value} onClick={() => setAmount(value)}>
                  {money(value)} บาท
                </button>
              ))}
            </div>
            <div className="ad-grid">
              <label className="ad-field">
                ยอดที่โอน (บาท)
                <input
                  type="number"
                  min={wallet.limits.min}
                  max={wallet.limits.max}
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </label>
              <label className="ad-field">
                รูปสลิป (JPEG / PNG / WebP)
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <div className="ad-row">
              <button className="ad-primary" disabled={busy === "topup"}>{busy === "topup" ? "กำลังตรวจสลิป…" : "ตรวจสลิปและเติมเงิน"}</button>
            </div>
          </form>

          <div className="ad-card">
            <h2>ซื้อแพ็กเกจ / แพ็กเสริม</h2>
            <div className="ad-grid">
              {wallet.packs.map((pack) => (
                <div key={pack.sku} className="ad-list-item">
                  <div>
                    <strong>{pack.label}</strong>
                    <p className="ad-muted">{money(pack.amount)} บาท</p>
                  </div>
                  <button
                    type="button"
                    className="ad-secondary"
                    disabled={Boolean(busy) || wallet.balance < pack.amount}
                    onClick={() => buy(pack.sku, pack.label)}
                  >
                    {wallet.balance < pack.amount ? "ยอดไม่พอ" : "ซื้อ"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="ad-card">
            <h2>รายการล่าสุด</h2>
            {wallet.entries.length === 0 ? (
              <p className="ad-muted">ยังไม่มีรายการ</p>
            ) : (
              <table className="ad-table">
                <thead><tr><th>วันที่</th><th>รายการ</th><th>จำนวน</th><th>คงเหลือ</th></tr></thead>
                <tbody>
                  {wallet.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.created_at).toLocaleString("th-TH")}</td>
                      <td>{entry.note ?? entry.kind}</td>
                      <td>{entry.amount > 0 ? "+" : ""}{money(entry.amount)}</td>
                      <td>{money(entry.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {wallet.topups.some((t) => t.status === "pending") && (
            <div className="ad-card">
              <h2>สลิปรอตรวจ</h2>
              <table className="ad-table">
                <thead><tr><th>วันที่</th><th>ยอด</th><th>เหตุผล</th></tr></thead>
                <tbody>
                  {wallet.topups.filter((t) => t.status === "pending").map((t) => (
                    <tr key={t.id}>
                      <td>{new Date(t.created_at).toLocaleString("th-TH")}</td>
                      <td>{money(t.amount)}</td>
                      <td>{(t.check_reasons ?? []).map((r) => REASON[r] ?? r).join(" · ") || "รอผู้ดูแลตรวจ"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
