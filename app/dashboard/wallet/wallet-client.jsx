"use client";

// กระเป๋าเงินของแบรนด์: ยอดคงเหลือ เติมเงินด้วยสลิป ซื้อแพ็กเกจ/แพ็กเสริม
// ใช้พื้นฐานหน้าจอ app/ui/ui.css (การ์ด/ตารางที่ยุบเป็นการ์ดบนมือถือ)

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
      setMessage({ kind: "danger", text: error.message });
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
      .catch((error) => setMessage({ kind: "danger", text: error.message }));
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
      setMessage({ kind: "danger", text: error.message });
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
      setMessage({ kind: "danger", text: error.message });
    } finally {
      setBusy("");
    }
  }

  if (user === undefined) return <main className="ui-page"><p className="ui-sub">กำลังโหลด…</p></main>;
  if (user === null) {
    return (
      <main className="ui-page">
        <section className="ui-card">
          <h2>กระเป๋าเงิน</h2>
          <p className="ui-sub">ต้องเข้าสู่ระบบก่อน</p>
          <a className="ui-btn ui-btn-primary" href="/dashboard">เข้าสู่ระบบ</a>
        </section>
      </main>
    );
  }

  const quota = wallet?.quota;
  const quotaTone = quota?.level === "full" ? "danger" : quota?.level === "warn" ? "warn" : "ok";

  return (
    <main className="ui-page">
      <header className="ui-head">
        <div>
          <h1 className="ui-title">กระเป๋าเงิน</h1>
          <p className="ui-sub">เติมเงินด้วยการโอนแล้วแนบสลิป — สลิปที่ถูกต้องเข้าอัตโนมัติ</p>
        </div>
        {brands.length > 1 && (
          <label className="ui-field" style={{ minWidth: 220 }}>
            แบรนด์
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
      </header>

      {message && <p className={"ui-banner ui-banner-" + message.kind}>{message.text}</p>}

      {!wallet ? (
        <p className="ui-sub">{busy ? "กำลังโหลด…" : "ไม่พบแบรนด์ที่คุณเป็นเจ้าของ"}</p>
      ) : (
        <>
          <div className="ui-stats">
            <div className="ui-stat">
              <small>ยอดคงเหลือ</small>
              <strong>{money(wallet.balance)} ฿</strong>
              <em>
                แพ็กเกจ {wallet.plan.effective}
                {wallet.plan.valid_until ? ` · ถึง ${new Date(wallet.plan.valid_until).toLocaleDateString("th-TH")}` : ""}
              </em>
            </div>
            <div className="ui-stat">
              <small>ข้อความ LINE เดือนนี้</small>
              <strong>{money(quota.used)} / {money(quota.total)}</strong>
              <em>
                {quota.level === "full"
                  ? "เต็มแล้ว — การ์ด LINE หยุดส่ง (การจอง/บิลยังทำงาน)"
                  : quota.level === "warn"
                    ? "ใกล้เต็มแล้ว (80%+)"
                    : `เหลือ ${money(quota.remaining)} ข้อความ`}
              </em>
            </div>
            <div className="ui-stat">
              <small>ตรวจสลิปอัตโนมัติเดือนนี้</small>
              <strong>{money(wallet.usage.slipsUsed)} / {money(wallet.usage.slipsPurchased)}</strong>
              <em>ครั้ง</em>
            </div>
          </div>

          <section className="ui-card">
            <h2>โควตาข้อความ LINE</h2>
            <div className="ui-bar" role="progressbar" aria-valuenow={quota.percent} aria-valuemin={0} aria-valuemax={100} aria-label="โควตาข้อความ LINE">
              <span
                style={{
                  width: `${quota.percent}%`,
                  background: quota.level === "full" ? "var(--danger)" : quota.level === "warn" ? "var(--warn)" : "var(--grape)"
                }}
              />
            </div>
            <p className="ui-sub">{quota.percent}% ของโควตา · ซื้อแพ็กข้อความด้านล่างเพื่อเพิ่ม</p>
          </section>

          <form className="ui-card" onSubmit={topUp}>
            <h2>เติมเงิน</h2>
            <p className="ui-sub">
              โอนเข้าบัญชี: {wallet.payTo?.promptPay ? `พร้อมเพย์ ${wallet.payTo.promptPay}` : "— ยังไม่ได้ตั้งใน /super"}
              {wallet.payTo?.accountName ? ` · ${wallet.payTo.accountName}` : ""}
              {wallet.payTo?.bank ? ` · ${wallet.payTo.bank}` : ""}
            </p>
            <div className="ui-row">
              {PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={"ui-btn " + (Number(amount) === value ? "ui-btn-primary" : "ui-btn-secondary")}
                  onClick={() => setAmount(value)}
                >
                  {money(value)} ฿
                </button>
              ))}
            </div>
            <div className="ui-grid-2">
              <label className="ui-field">
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
              <label className="ui-field">
                รูปสลิป (JPEG / PNG / WebP)
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <div className="ui-row">
              <button className="ui-btn ui-btn-primary" disabled={busy === "topup"}>
                {busy === "topup" ? "กำลังตรวจสลิป…" : "ตรวจสลิปและเติมเงิน"}
              </button>
            </div>
          </form>

          <section className="ui-card">
            <h2>ซื้อแพ็กเกจ / แพ็กเสริม</h2>
            <div className="ui-grid-2">
              {wallet.packs.map((pack) => (
                <div key={pack.sku} className="ui-card" style={{ padding: 12 }}>
                  <strong>{pack.label}</strong>
                  <p className="ui-sub" style={{ margin: 0 }}>{money(pack.amount)} บาท</p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary"
                    disabled={Boolean(busy) || wallet.balance < pack.amount}
                    onClick={() => buy(pack.sku, pack.label)}
                  >
                    {wallet.balance < pack.amount ? "ยอดไม่พอ" : "ซื้อ"}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="ui-card">
            <h2>รายการล่าสุด</h2>
            {wallet.entries.length === 0 ? (
              <p className="ui-empty">ยังไม่มีรายการ</p>
            ) : (
              <table className="ui-table ui-table-stack">
                <thead><tr><th>วันที่</th><th>รายการ</th><th>จำนวน</th><th>คงเหลือ</th></tr></thead>
                <tbody>
                  {wallet.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td data-label="วันที่">{new Date(entry.created_at).toLocaleString("th-TH")}</td>
                      <td data-label="รายการ">{entry.note ?? entry.kind}</td>
                      <td data-label="จำนวน">{entry.amount > 0 ? "+" : ""}{money(entry.amount)}</td>
                      <td data-label="คงเหลือ">{money(entry.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {wallet.topups.some((t) => t.status === "pending") && (
            <section className="ui-card">
              <h2>สลิปรอตรวจ</h2>
              <table className="ui-table ui-table-stack">
                <thead><tr><th>วันที่</th><th>ยอด</th><th>เหตุผล</th></tr></thead>
                <tbody>
                  {wallet.topups.filter((t) => t.status === "pending").map((t) => (
                    <tr key={t.id}>
                      <td data-label="วันที่">{new Date(t.created_at).toLocaleString("th-TH")}</td>
                      <td data-label="ยอด">{money(t.amount)}</td>
                      <td data-label="เหตุผล">{(t.check_reasons ?? []).map((r) => REASON[r] ?? r).join(" · ") || "รอผู้ดูแลตรวจ"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </main>
  );
}
