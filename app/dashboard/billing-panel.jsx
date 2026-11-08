"use client";

// แพ็กเกจและการชำระเงิน (docs/BILLING_PLAN.md ข้อ 3): แพ็กเกจปัจจุบัน + การใช้งาน, กระเป๋าเงิน,
// เติมเงินด้วย QR พร้อมเพย์ + สลิป, ตารางเทียบแพ็กเกจ, แพ็กเสริม และประวัติ
// ใช้ทั้งในแท็บ "billing" ของแดชบอร์ดร้าน และหน้า /dashboard/wallet

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.mjs";

const money = (n) => Number(n ?? 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const thDate = (value) => (value ? new Date(value).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }) : "");
const thDateTime = (value) => new Date(value).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DAY = 24 * 3600 * 1000;
const PRESETS = [500, 1000, 3000];
const SLIP_LIMIT = 1_400_000;

export const TOPUP_REASON = {
  AMOUNT_LOW: "ยอดโอนน้อยกว่ายอดที่เลือก",
  AMOUNT_HIGH: "ยอดโอนเกิน 20,000 บาท",
  RECEIVER_MISMATCH: "โอนเข้าบัญชีที่ไม่ใช่บัญชีของ Kiwmee",
  RECEIVER_UNKNOWN: "ระบบยังตรวจบัญชีผู้รับไม่ได้",
  DUPLICATE: "สลิปนี้เคยใช้เติมเงินแล้ว",
  TOO_OLD: "สลิปเก่ากว่า 7 วัน",
  IN_FUTURE: "เวลาบนสลิปไม่ถูกต้อง",
  UNREADABLE: "อ่านสลิปไม่ได้"
};
const ENTRY_KIND = { topup: "เติมเงิน", purchase: "ซื้อ", refund: "คืนเงิน", adjust: "ปรับยอด" };

/** "∞" for no limit, a number with its unit otherwise; "—" when the plan has none of it */
export function limitText(value, unit = "") {
  if (value === null || value === undefined) return "ไม่จำกัด";
  if (value === 0) return "—";
  return `${money(value)}${unit ? ` ${unit}` : ""}`;
}

/** The plan the shop holds and what buying `plan` would give: { until, switching } */
export function purchaseOutcome(current, planId, now = new Date()) {
  // a different plan replacing a free (complimentary) one starts today; otherwise days run on
  const restart = current?.complimentary && current.effective !== planId;
  const from = Math.max(now.getTime(), !restart && current?.valid_until ? new Date(current.valid_until).getTime() : 0);
  return { until: new Date(from + 30 * DAY), switching: Boolean(current && current.effective !== planId && current.effective !== "free") };
}

/** A phone photo of a slip can be several MB: shrink it to a JPEG the server accepts (≤ ~1.4 MB) */
async function shrinkSlip(file) {
  if (file.size <= SLIP_LIMIT || typeof document === "undefined") return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? new File([blob], "slip.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const key = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = overflow; };
  }, [onClose]);
  return (
    <div className="ad-sheet-layer">
      <div className="ad-sheet-backdrop" aria-hidden="true" />
      <div className="ad-sheet bl-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ad-sheet-head">
          <button type="button" className="ad-sheet-back" onClick={onClose}>← กลับ</button>
          <strong>{title}</strong>
          <button type="button" className="ad-sheet-x" onClick={onClose} aria-label="ปิด">✕</button>
        </div>
        <div className="ad-sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Meter({ label, used, limit, unit, capacity = false }) {
  const unlimited = limit === null || limit === undefined;
  const none = limit === 0;
  const percent = unlimited || none ? 0 : Math.min(100, Math.round((used / limit) * 100));
  // a monthly allowance warns as it runs out; a capacity (people, branches) only when it is exceeded
  const over = !unlimited && !none && used > limit;
  const tone = capacity ? (over ? "over" : "ok") : percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok";
  return (
    <div className="bl-meter" data-tone={tone}>
      <div className="bl-meter-top"><span>{label}</span><b>{money(used)}{unlimited ? "" : none ? "" : ` / ${money(limit)}`}{unit ? ` ${unit}` : ""}{unlimited ? " · ไม่จำกัด" : ""}</b></div>
      {over && capacity && <small className="bl-meter-note">เกินสิทธิ์ของแพ็กเกจนี้</small>}
      {!unlimited && !none && <div className="bl-bar" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>}
    </div>
  );
}

function TopupSheet({ brandId, wallet, initialAmount, onClose, onDone }) {
  const [amount, setAmount] = useState(String(initialAmount || 1000));
  const [qr, setQr] = useState(null);
  const [qrError, setQrError] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState("");
  const input = useRef(null);
  const value = Number(amount);
  const valid = Number.isInteger(value) && value >= wallet.limits.min && value <= wallet.limits.max;

  useEffect(() => {
    if (!valid) { setQr(null); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api("POST", `/api/dashboard/brands/${brandId}/wallet/qr`, { amount: value })
        .then((r) => { if (live) { setQr(r.qr); setQrError(r.qr ? "" : "ยังไม่ได้ตั้งพร้อมเพย์ของ Kiwmee"); } })
        .catch((e) => { if (live) { setQr(null); setQrError(e.message); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [brandId, value, valid]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (f) => {
    if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) { setResult({ kind: "error", text: "ใช้รูปสลิป JPEG, PNG หรือ WebP" }); return; }
    setResult(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };
  const copy = (text, what) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(""), 1500); }, () => {});
  };

  async function submit() {
    if (!file || !valid) return;
    setBusy(true);
    setResult(null);
    try {
      const body = await shrinkSlip(file);
      const response = await fetch(`/api/dashboard/brands/${brandId}/wallet/topups?amount=${value}`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": body.type || "image/jpeg" }, body
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "เติมเงินไม่สำเร็จ");
      const r = payload.data;
      if (r.status === "credited") setResult({ kind: "ok", text: `เติมเงิน ${money(r.credited)} บาทแล้ว · ยอดใหม่ ${money(r.balance)} บาท` });
      else if (r.reasons?.length) setResult({ kind: "pending", text: `สลิปยังไม่ผ่านการตรวจอัตโนมัติ: ${r.reasons.map((x) => TOPUP_REASON[x] ?? x).join(" · ")}`, note: "ส่งให้ทีมงานตรวจแล้ว เงินจะเข้าเมื่อทีมงานยืนยัน" });
      else setResult({ kind: "pending", text: "ได้รับสลิปแล้ว รอทีมงานตรวจ", note: "เงินจะเข้ากระเป๋าเมื่อทีมงานยืนยัน" });
      setFile(null);
      setPreview("");
      onDone();
    } catch (e) {
      setResult({ kind: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (result?.kind === "ok" || result?.kind === "pending") {
    return (
      <Sheet title="เติมเงิน" onClose={onClose}>
        <div className="ad-card bl-result" data-kind={result.kind}>
          <span className="bl-result-icon" aria-hidden="true">{result.kind === "ok" ? "✓" : "⏳"}</span>
          <h2>{result.kind === "ok" ? "เติมเงินสำเร็จ" : "รอตรวจสลิป"}</h2>
          <p>{result.text}</p>
          {result.note && <p className="ad-muted">{result.note}</p>}
          <button type="button" className="ad-primary" onClick={onClose}>เสร็จแล้ว</button>
        </div>
      </Sheet>
    );
  }

  const payTo = wallet.payTo ?? {};
  return (
    <Sheet title="เติมเงินเข้ากระเป๋า" onClose={onClose}>
      <div className="ad-card bl-topup">
        <section className="bl-step">
          <h3><span className="bl-step-no">1</span>เลือกยอดเงิน</h3>
          <div className="bl-presets">
            {PRESETS.map((p) => <button key={p} type="button" data-on={value === p} onClick={() => setAmount(String(p))}>{money(p)} ฿</button>)}
            <label className="bl-amount">
              <span className="ad-media-sr-only">ยอดเงิน (บาท)</span>
              <input type="number" inputMode="numeric" min={wallet.limits.min} max={wallet.limits.max} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="ยอดเงิน (บาท)" />
              <span>บาท</span>
            </label>
          </div>
          {!valid && <p className="ad-error">ยอดเติมเงิน {money(wallet.limits.min)}–{money(wallet.limits.max)} บาท (จำนวนเต็ม)</p>}
        </section>

        <section className="bl-step">
          <h3><span className="bl-step-no">2</span>สแกนจ่ายด้วยแอปธนาคาร</h3>
          <div className="bl-pay">
            <div className="bl-qr">
              {qr ? <img src={qr} alt={`QR พร้อมเพย์ ยอด ${money(value)} บาท`} width="220" height="220" /> : <span className="ad-muted">{valid ? qrError || "กำลังสร้าง QR…" : "เลือกยอดเงินก่อน"}</span>}
              {qr && <a className="ad-link" href={qr} download={`kiwmee-topup-${value}.png`}>บันทึกรูป QR</a>}
            </div>
            <dl className="bl-payto">
              <div><dt>ยอดที่ต้องโอน</dt><dd className="bl-payto-amount">{valid ? `${money(value)} บาท` : "—"}</dd></div>
              {payTo.promptPay && <div><dt>พร้อมเพย์</dt><dd>{payTo.promptPay} <button type="button" className="ad-link" onClick={() => copy(payTo.promptPay, "pp")}>{copied === "pp" ? "คัดลอกแล้ว" : "คัดลอก"}</button></dd></div>}
              {payTo.bank && <div><dt>บัญชีธนาคาร</dt><dd>{payTo.bank}</dd></div>}
              {payTo.accountName && <div><dt>ชื่อบัญชี</dt><dd>{payTo.accountName}</dd></div>}
              {!payTo.promptPay && !payTo.bank && <p className="ad-error">ยังไม่ได้ตั้งบัญชีรับเงินของ Kiwmee — ติดต่อทีมงาน</p>}
            </dl>
          </div>
        </section>

        <section className="bl-step">
          <h3><span className="bl-step-no">3</span>แนบสลิป</h3>
          <label className="bl-drop" data-has={Boolean(file)} onDragOver={(e) => { e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer?.files?.[0]); }}>
            {preview ? <img src={preview} alt="สลิปที่เลือก" /> : <span className="ad-media-add-icon" aria-hidden="true">＋</span>}
            <strong>{file ? "เปลี่ยนรูปสลิป" : "เลือกรูปสลิปจากเครื่อง"}</strong>
            <small>หรือลากรูปมาวาง · JPEG, PNG, WebP</small>
            <input ref={input} className="ad-media-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} aria-label="เลือกรูปสลิป" />
          </label>
          {result?.kind === "error" && <p className="ad-error" role="alert">{result.text}</p>}
          <p className="ad-muted">ระบบตรวจสลิปอัตโนมัติ ถ้ายอดและบัญชีผู้รับถูกต้อง เงินเข้ากระเป๋าทันที</p>
        </section>

        <div className="ad-row bl-actions">
          <button type="button" className="ad-primary" disabled={!file || !valid || busy} onClick={submit}>{busy ? "กำลังตรวจสลิป…" : `ยืนยันเติมเงิน ${valid ? money(value) : ""} บาท`}</button>
        </div>
      </div>
    </Sheet>
  );
}

function BuySheet({ brandId, wallet, item, onClose, onDone, onTopup }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const after = wallet.balance - item.amount;
  const short = Math.max(0, item.amount - wallet.balance);
  const outcome = item.plan ? purchaseOutcome(wallet.plan, item.plan) : null;

  async function buy() {
    setBusy(true);
    setError("");
    try {
      const r = await api("POST", `/api/dashboard/brands/${brandId}/wallet/orders`, { sku: item.sku });
      setDone(r);
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={done ? "ซื้อสำเร็จ" : "ยืนยันการซื้อ"} onClose={onClose}>
      {done ? (
        <div className="ad-card bl-result" data-kind="ok">
          <span className="bl-result-icon" aria-hidden="true">✓</span>
          <h2>{done.label}</h2>
          <p>ตัดจากกระเป๋า {money(done.paid)} บาท · คงเหลือ {money(done.balance)} บาท</p>
          {outcome && <p className="ad-muted">ใช้ได้ถึง {thDate(outcome.until)}</p>}
          <button type="button" className="ad-primary" onClick={onClose}>เสร็จแล้ว</button>
        </div>
      ) : (
        <div className="ad-card bl-confirm">
          <h2>{item.label}</h2>
          <dl className="bl-sum">
            <div><dt>ราคา</dt><dd>{money(item.amount)} บาท</dd></div>
            <div><dt>ยอดในกระเป๋า</dt><dd>{money(wallet.balance)} บาท</dd></div>
            <div data-strong="true"><dt>คงเหลือหลังซื้อ</dt><dd>{short ? "—" : `${money(after)} บาท`}</dd></div>
          </dl>
          {outcome && (
            <p className="ad-notice">
              {outcome.switching ? `เปลี่ยนจากแพ็กเกจ${wallet.planName}เป็นแพ็กเกจนี้ทันที · ` : ""}ใช้ได้ถึง {thDate(outcome.until)}
              {wallet.plan.auto_renew !== false ? " · ต่ออายุอัตโนมัติจากกระเป๋าเมื่อเหลือ 3 วัน" : ""}
            </p>
          )}
          {error && <p className="ad-error" role="alert">{error}</p>}
          {short ? (
            <>
              <p className="ad-error">ยอดในกระเป๋าไม่พอ ขาดอีก {money(short)} บาท</p>
              <button type="button" className="ad-primary" onClick={() => onTopup(Math.max(wallet.limits.min, Math.ceil(short)))}>เติมเงิน {money(Math.max(wallet.limits.min, Math.ceil(short)))} บาท</button>
            </>
          ) : (
            <button type="button" className="ad-primary" disabled={busy} onClick={buy}>{busy ? "กำลังซื้อ…" : `ยืนยันซื้อ ${money(item.amount)} บาท`}</button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** A cheaper plan cannot replace a paid one that still has days left (B4 will schedule it for the next cycle) */
export function downgradeBlocked(catalog, current, planId, validUntil, now = new Date()) {
  const from = catalog.plans.find((p) => p.id === current);
  const to = catalog.plans.find((p) => p.id === planId);
  return Boolean(from && to && from.monthly > to.monthly && to.monthly > 0 && validUntil && new Date(validUntil) > now);
}

export function PlanCards({ catalog, current, validUntil = null, onPick }) {
  return (
    <div className="bl-plans">
      {catalog.plans.map((p) => {
        const isCurrent = current === p.id;
        const blocked = downgradeBlocked(catalog, current, p.id, validUntil);
        return (
          <article key={p.id} className="bl-plan" data-current={isCurrent} data-recommended={Boolean(p.recommended)}>
            {p.recommended && <span className="bl-plan-flag">แนะนำ</span>}
            <h3>{p.name}</h3>
            <p className="bl-plan-tag">{p.tagline}</p>
            <p className="bl-plan-price"><b>{money(p.monthly)}</b> บาท/เดือน</p>
            {p.yearly > 0 && <p className="bl-plan-year">รายปี {money(p.yearly)} บาท (ประหยัด 2 เดือน · เร็ว ๆ นี้)</p>}
            <ul className="bl-plan-list">
              {catalog.limitRows.map((row) => (
                <li key={row.key} data-off={p.limits[row.key] === 0}><span>{row.label}</span><b>{limitText(p.limits[row.key], row.unit)}</b></li>
              ))}
              {catalog.featureRows.map((row) => (
                <li key={row.key} data-off={!p.features[row.key]}><span>{row.label}</span><b aria-label={p.features[row.key] ? "มี" : "ไม่มี"}>{p.features[row.key] ? "✓" : "—"}</b></li>
              ))}
            </ul>
            {blocked ? (
              <p className="bl-plan-note">เปลี่ยนเป็นแพ็กเกจนี้ได้เมื่อแพ็กเกจปัจจุบันหมดอายุ</p>
            ) : p.monthly > 0 ? (
              <button type="button" className={isCurrent ? "ad-secondary" : "ad-primary"} onClick={() => onPick(p)}>{isCurrent ? "ต่ออายุ 1 เดือน" : `เลือกแพ็กเกจ${p.name}`}</button>
            ) : (
              <p className="bl-plan-note">{isCurrent ? "แพ็กเกจปัจจุบัน" : "กลับเป็นแพ็กเกจฟรีเองเมื่อแพ็กเกจหมดอายุ"}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}

export default function BillingPanel({ brandId }) {
  const [wallet, setWallet] = useState(null);
  const [error, setError] = useState("");
  const [topup, setTopup] = useState(null); // amount to start with
  const [buying, setBuying] = useState(null);

  const load = useCallback(() => {
    if (!brandId) return;
    api("GET", `/api/dashboard/brands/${brandId}/wallet`).then((w) => { setWallet(w); setError(""); }, (e) => setError(e.message));
  }, [brandId]);
  useEffect(load, [load]);
  const closeTopup = useCallback(() => setTopup(null), []);
  const closeBuy = useCallback(() => setBuying(null), []);

  if (!brandId) return <p className="ad-error">ร้านนี้ยังไม่อยู่ในแบรนด์</p>;
  if (error && !wallet) return <section className="ad-card"><p className="ad-error" role="alert">{error}</p><p className="ad-muted">หน้านี้สำหรับเจ้าของแบรนด์เท่านั้น</p></section>;
  if (!wallet) return <p className="ad-muted">กำลังโหลด…</p>;

  const { catalog } = wallet;
  const plan = catalog.plans.find((p) => p.id === wallet.plan.effective) ?? catalog.plans[0];
  const paid = plan.monthly > 0;
  const months = paid ? Math.floor(wallet.balance / plan.monthly) : 0;
  const daysLeft = wallet.planDaysLeft;
  const soon = paid && daysLeft != null && daysLeft <= 7;
  const pending = wallet.topups.filter((t) => t.status === "pending");
  const quota = wallet.quota;
  const pickPlan = (p) => setBuying({ sku: `plan:${p.id}`, label: `แพ็กเกจ${p.name} 1 เดือน`, amount: p.monthly, plan: p.id });

  return (
    <div className="ad-stack bl-page">
      {wallet.plan.complimentary && wallet.plan.valid_until && (
        <p className="bl-alert" data-tone="gift">
          🎁 ร้านของคุณใช้แพ็กเกจ{plan.name}ฟรีถึง {thDate(wallet.plan.valid_until)} · ไม่ตัดเงินจากกระเป๋า · หลังจากนั้นกลับเป็นแพ็กเกจฟรี ถ้ายังไม่ได้เลือกแพ็กเกจ
          <small>ซื้อแพ็กเกจ{plan.name}ล่วงหน้าได้ วันใช้งานจะต่อจากวันที่ใช้ฟรีหมด</small>
        </p>
      )}
      {soon && !wallet.plan.complimentary && (
        <p className="bl-alert" data-tone={wallet.balance >= plan.monthly ? "info" : "warn"}>
          {daysLeft <= 0 ? `แพ็กเกจ${plan.name}หมดอายุแล้ว` : `แพ็กเกจ${plan.name}จะหมดอายุในอีก ${daysLeft} วัน`}
          {wallet.balance >= plan.monthly ? " · ระบบจะต่ออายุจากกระเป๋าให้อัตโนมัติ" : ` · เติมเงินอีก ${money(plan.monthly - wallet.balance)} บาทเพื่อต่ออายุอัตโนมัติ`}
          {wallet.balance < plan.monthly && <button type="button" className="ad-link" onClick={() => setTopup(Math.max(wallet.limits.min, Math.ceil(plan.monthly - wallet.balance)))}>เติมเงิน</button>}
        </p>
      )}

      <div className="bl-top">
        <section className="ad-card bl-current">
          <div className="bl-current-head">
            <div>
              <p className="ad-muted">แพ็กเกจปัจจุบัน</p>
              <h2>{plan.name}</h2>
              <p className="ad-muted">{paid ? (wallet.plan.valid_until ? `ใช้ได้ถึง ${thDate(wallet.plan.valid_until)}${daysLeft > 0 ? ` (อีก ${daysLeft} วัน)` : ""}` : "ไม่มีวันหมดอายุ") : "ใช้ได้ไม่มีค่าใช้จ่าย"}</p>
            </div>
            {paid && (wallet.plan.complimentary
              ? <span className="ad-status" data-tone="info">ข้อเสนอเปิดตัว · ใช้ฟรี</span>
              : <span className="ad-status" data-tone="ok">ต่ออายุอัตโนมัติจากกระเป๋า</span>)}
          </div>
          <div className="bl-meters">
            <Meter label="การจองออนไลน์เดือนนี้" used={wallet.counts.bookings} limit={plan.limits.bookingsPerMonth} unit="ครั้ง" />
            <Meter label="ข้อความ LINE เดือนนี้" used={quota.used} limit={quota.total} />
            <Meter label="ตรวจสลิปอัตโนมัติเดือนนี้" used={wallet.usage.slipsUsed} limit={plan.limits.slipChecks + (wallet.usage.slipsPurchased || 0)} unit="ครั้ง" />
            <Meter capacity label="ช่าง / สนาม / ห้องที่เปิดอยู่" used={wallet.counts.resources} limit={plan.limits.resources} />
            <Meter capacity label="บัญชีพนักงาน" used={wallet.counts.members} limit={plan.limits.members} unit="คน" />
            <Meter capacity label="สาขา" used={wallet.counts.branches} limit={plan.limits.branches} unit="สาขา" />
          </div>
        </section>

        <section className="ad-card bl-wallet">
          <p className="ad-muted">ยอดในกระเป๋าเงิน</p>
          <p className="bl-balance">{money(wallet.balance)} <small>บาท</small></p>
          <p className="ad-muted">{paid && wallet.plan.complimentary ? "ใช้ซื้อแพ็กเกจล่วงหน้าและแพ็กเสริม" : paid ? (months > 0 ? `พอต่อแพ็กเกจ${plan.name}ได้อีก ${months} เดือน` : `ยังไม่พอต่อแพ็กเกจ${plan.name} (${money(plan.monthly)} บาท)`) : "ใช้ซื้อแพ็กเกจและแพ็กเสริม"}</p>
          <button type="button" className="ad-primary" onClick={() => setTopup(paid && wallet.balance < plan.monthly ? Math.max(wallet.limits.min, Math.ceil(plan.monthly - wallet.balance)) : 1000)}>เติมเงิน</button>
          {pending.length > 0 && <p className="bl-pending">⏳ สลิปรอตรวจ {pending.length} ใบ · รวม {money(pending.reduce((s, t) => s + t.amount, 0))} บาท</p>}
          <p className="bl-wallet-note">โอนผ่านพร้อมเพย์แล้วแนบสลิป · ตรวจอัตโนมัติ เงินเข้าทันที</p>
        </section>
      </div>

      <section className="ad-card">
        <div className="ad-card-head"><h2>เลือกแพ็กเกจ</h2><p className="ad-muted">ทุกแพ็กเกจได้ {catalog.everyPlan.join(" · ")} · ราคายังไม่รวม VAT</p></div>
        <PlanCards catalog={catalog} current={plan.id} validUntil={wallet.plan.valid_until} onPick={pickPlan} />
      </section>

      <section className="ad-card">
        <div className="ad-card-head"><h2>แพ็กเสริม</h2><p className="ad-muted">ซื้อเพิ่มเมื่อใช้เกินโควตาของแพ็กเกจ ใช้ได้ในเดือนที่ซื้อ</p></div>
        <div className="bl-addons">
          {catalog.addons.map((a) => (
            <button key={a.sku} type="button" className="bl-addon" onClick={() => setBuying({ sku: a.sku, label: a.label, amount: a.amount })}>
              <span className="bl-addon-icon" aria-hidden="true">{a.group === "messages" ? "💬" : "🧾"}</span>
              <span><strong>{a.short}</strong><small>{a.group === "messages" ? "ข้อความ LINE" : "ตรวจสลิปอัตโนมัติ"}</small></span>
              <b>{money(a.amount)} ฿</b>
            </button>
          ))}
        </div>
      </section>

      <section className="ad-card">
        <div className="ad-card-head"><h2>ประวัติการเงิน</h2></div>
        {pending.map((t) => (
          <div key={t.id} className="bl-entry" data-kind="pending">
            <span className="bl-entry-icon" aria-hidden="true">⏳</span>
            <span><strong>เติมเงิน (รอตรวจ)</strong><small>{thDateTime(t.created_at)} · {(t.check_reasons ?? []).map((r) => TOPUP_REASON[r] ?? r).join(" · ") || "รอทีมงานตรวจสลิป"}</small></span>
            <b>{money(t.amount)}</b>
          </div>
        ))}
        {wallet.entries.length === 0 && pending.length === 0 && <p className="ad-empty">ยังไม่มีรายการ</p>}
        {wallet.entries.map((e) => (
          <div key={e.id} className="bl-entry" data-kind={e.amount > 0 ? "in" : "out"}>
            <span className="bl-entry-icon" aria-hidden="true">{e.amount > 0 ? "↓" : "↑"}</span>
            <span><strong>{e.note || ENTRY_KIND[e.kind] || e.kind}</strong><small>{thDateTime(e.created_at)} · คงเหลือ {money(e.balance_after)}</small></span>
            <b>{e.amount > 0 ? "+" : "−"}{money(Math.abs(e.amount))}</b>
          </div>
        ))}
      </section>

      {topup && <TopupSheet brandId={brandId} wallet={wallet} initialAmount={topup} onClose={closeTopup} onDone={load} />}
      {buying && <BuySheet brandId={brandId} wallet={wallet} item={buying} onClose={closeBuy} onDone={load} onTopup={(amount) => { setBuying(null); setTopup(amount); }} />}
    </div>
  );
}
