"use client";

// แพ็กเกจและการชำระเงิน (docs/BILLING_PLAN.md ข้อ 3): แพ็กเกจปัจจุบัน + การใช้งาน, กระเป๋าเงิน,
// เติมเงินด้วย QR พร้อมเพย์ + สลิป, ตารางเทียบแพ็กเกจ, แพ็กเสริม และประวัติ
// ใช้ทั้งในแท็บ "billing" ของแดชบอร์ดร้าน และหน้า /dashboard/wallet

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.mjs";
import { quotePlan } from "../../src/v2/plans.js";

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

const MODE_TEXT = {
  new: "เริ่มใช้วันนี้",
  after_free: "เริ่มต่อจากวันที่ใช้ฟรีหมด",
  renew: "ต่อจากวันหมดอายุเดิม",
  upgrade: "อัปเกรดทันที จ่ายเฉพาะส่วนต่างของวันที่เหลือ · วันหมดอายุเท่าเดิม",
  switch: "เริ่มรอบรายปีวันนี้ หักมูลค่าวันที่เหลือของรอบเดิมแล้ว"
};
const cycleWord = (cycle) => (cycle === "year" ? "1 ปี" : "1 เดือน");

function BuySheet({ brandId, wallet, item, onClose, onDone, onTopup }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const after = wallet.balance - item.amount;
  const short = Math.max(0, item.amount - wallet.balance);
  const quote = item.quote ?? null;

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
          {done.plan && <p className="ad-muted">ใช้ได้ถึง {thDate(done.plan.validUntil)}</p>}
          <button type="button" className="ad-primary" onClick={onClose}>เสร็จแล้ว</button>
        </div>
      ) : (
        <div className="ad-card bl-confirm">
          <h2>{item.label}</h2>
          <dl className="bl-sum">
            {quote && quote.amount !== item.full && <div><dt>ราคาเต็ม</dt><dd>{money(item.full)} บาท</dd></div>}
            <div><dt>{quote && quote.amount !== item.full ? "จ่ายวันนี้" : "ราคา"}</dt><dd>{money(item.amount)} บาท</dd></div>
            <div><dt>ยอดในกระเป๋า</dt><dd>{money(wallet.balance)} บาท</dd></div>
            <div data-strong="true"><dt>คงเหลือหลังซื้อ</dt><dd>{short ? "—" : `${money(after)} บาท`}</dd></div>
          </dl>
          {quote && (
            <p className="ad-notice">
              {MODE_TEXT[quote.mode]} · ใช้ได้ถึง {thDate(quote.validUntil)} · ต่ออายุอัตโนมัติจากกระเป๋าเมื่อเหลือ 3 วัน (ปิดได้)
            </p>
          )}
          {error && <p className="ad-error" role="alert">{error}</p>}
          {short ? (
            <>
              <p className="ad-error">ยอดในกระเป๋าไม่พอ ขาดอีก {money(short)} บาท</p>
              <button type="button" className="ad-primary" onClick={() => onTopup(Math.max(wallet.limits.min, Math.ceil(short)))}>เติมเงิน {money(Math.max(wallet.limits.min, Math.ceil(short)))} บาท</button>
            </>
          ) : (
            <button type="button" className="ad-primary" disabled={busy} onClick={buy}>{busy ? "กำลังซื้อ…" : `ยืนยันจ่าย ${money(item.amount)} บาท`}</button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** What switching from one plan to another switches off (for "from the next renewal") */
export function lostFeatures(catalog, fromId, toId) {
  const from = catalog.plans.find((p) => p.id === fromId);
  const to = catalog.plans.find((p) => p.id === toId);
  if (!from || !to) return [];
  const lost = catalog.featureRows.filter((row) => from.features[row.key] && !to.features[row.key]).map((row) => row.label);
  for (const row of catalog.limitRows) {
    const a = from.limits[row.key];
    const b = to.limits[row.key];
    if (b !== null && (a === null || a > b)) lost.push(b === 0 ? `${row.label}: ไม่มี` : `${row.label} เหลือ ${limitText(b, row.unit)}`);
  }
  return lost;
}

function ScheduleSheet({ brandId, wallet, target, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { catalog } = wallet;
  const from = wallet.plan.effective;
  const toFree = target.plan === "free";
  const lost = lostFeatures(catalog, from, target.plan);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("PUT", `/api/dashboard/brands/${brandId}/wallet/plan`, toFree ? { autoRenew: false, nextPlan: "free" } : { autoRenew: true, nextPlan: target.plan, nextCycle: target.cycle });
      onDone();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const name = catalog.plans.find((p) => p.id === target.plan)?.name ?? target.plan;
  return (
    <Sheet title="เปลี่ยนแพ็กเกจรอบถัดไป" onClose={onClose}>
      <div className="ad-card bl-confirm">
        <h2>{toFree ? "ไม่ต่ออายุ · กลับเป็นแพ็กเกจฟรี" : `เปลี่ยนเป็นแพ็กเกจ${name} ${cycleWord(target.cycle)}`}</h2>
        <p className="ad-notice">ใช้แพ็กเกจ{wallet.planName}ต่อได้ถึง {thDate(wallet.plan.valid_until)} · ไม่ตัดเงินวันนี้{toFree ? "" : ` · วันนั้นระบบจะตัด ${money(target.amount)} บาทจากกระเป๋า`}</p>
        {lost.length > 0 && (
          <div className="ad-field">
            สิ่งที่จะถูกพักไว้ (ข้อมูลไม่หาย กลับมาใช้ได้เมื่ออัปเกรด)
            <ul className="bl-lost">{lost.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
        {error && <p className="ad-error" role="alert">{error}</p>}
        <button type="button" className="ad-primary" disabled={busy} onClick={save}>{busy ? "กำลังบันทึก…" : "ยืนยัน"}</button>
      </div>
    </Sheet>
  );
}

/** One plan card's button: what buying it today means (src/v2/plans.js quotePlan) */
function planAction(wallet, p, cycle) {
  const current = wallet.plan;
  const paidRunning = current.effective !== "free" && !current.complimentary && current.valid_until && new Date(current.valid_until) > new Date();
  if (p.monthly === 0) {
    if (!paidRunning) return { kind: "note", text: current.effective === "free" ? "แพ็กเกจปัจจุบัน" : "กลับเป็นแพ็กเกจฟรีเองเมื่อแพ็กเกจหมดอายุ" };
    if (current.next_plan === "free" || current.auto_renew === false) return { kind: "note", text: `กลับเป็นแพ็กเกจฟรี ${thDate(current.valid_until)}` };
    return { kind: "schedule", label: "ไม่ต่ออายุ · กลับเป็นฟรีรอบหน้า", target: { plan: "free", cycle: "month", amount: 0 } };
  }
  const quote = quotePlan(current, p.id, cycle);
  if (quote.mode === "schedule") {
    const amount = cycle === "year" ? p.yearly : p.monthly;
    if (current.next_plan === p.id && (current.next_cycle ?? current.cycle) === cycle) return { kind: "note", text: `เริ่มรอบถัดไป ${thDate(current.valid_until)}` };
    return { kind: "schedule", label: `เปลี่ยนเป็นแพ็กเกจนี้รอบหน้า`, target: { plan: p.id, cycle, amount } };
  }
  const label = {
    new: `เลือกแพ็กเกจ${p.name}`,
    after_free: `ซื้อล่วงหน้า ${money(quote.amount)} บาท`,
    renew: `ต่ออายุ ${cycleWord(cycle)}`,
    upgrade: `อัปเกรด · จ่าย ${money(quote.amount)} บาท`,
    switch: `เปลี่ยนเป็นรายปี · ${money(quote.amount)} บาท`
  }[quote.mode];
  return { kind: "buy", label, quote };
}

export function PlanCards({ wallet, cycle = "month", onPick, onSchedule }) {
  const { catalog } = wallet;
  const current = wallet.plan.effective;
  return (
    <div className="bl-plans">
      {catalog.plans.map((p) => {
        const isCurrent = current === p.id;
        const action = planAction(wallet, p, cycle);
        const price = cycle === "year" ? p.yearly : p.monthly;
        return (
          <article key={p.id} className="bl-plan" data-current={isCurrent} data-recommended={Boolean(p.recommended)}>
            {p.recommended && <span className="bl-plan-flag">แนะนำ</span>}
            <h3>{p.name}</h3>
            <p className="bl-plan-tag">{p.tagline}</p>
            <p className="bl-plan-price"><b>{money(price)}</b> บาท/{cycle === "year" ? "ปี" : "เดือน"}</p>
            {p.yearly > 0 && <p className="bl-plan-year">{cycle === "year" ? `เฉลี่ย ${money(Math.round(p.yearly / 12))} บาท/เดือน · ประหยัด 2 เดือน` : `รายปี ${money(p.yearly)} บาท (ประหยัด 2 เดือน)`}</p>}
            <ul className="bl-plan-list">
              {catalog.limitRows.map((row) => (
                <li key={row.key} data-off={p.limits[row.key] === 0}><span>{row.label}</span><b>{limitText(p.limits[row.key], row.unit)}</b></li>
              ))}
              {catalog.featureRows.map((row) => (
                <li key={row.key} data-off={!p.features[row.key]}><span>{row.label}</span><b aria-label={p.features[row.key] ? "มี" : "ไม่มี"}>{p.features[row.key] ? "✓" : "—"}</b></li>
              ))}
            </ul>
            {action.kind === "buy" && (
              <button type="button" className={isCurrent ? "ad-secondary" : "ad-primary"} onClick={() => onPick(p, action.quote, cycle)}>{action.label}</button>
            )}
            {action.kind === "schedule" && <button type="button" className="ad-secondary" onClick={() => onSchedule(action.target)}>{action.label}</button>}
            {action.kind === "note" && <p className="bl-plan-note">{action.text}</p>}
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
  const [scheduling, setScheduling] = useState(null);
  const [cycle, setCycle] = useState("month");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!brandId) return;
    api("GET", `/api/dashboard/brands/${brandId}/wallet`).then((w) => { setWallet(w); setError(""); }, (e) => setError(e.message));
  }, [brandId]);
  useEffect(load, [load]);
  const closeTopup = useCallback(() => setTopup(null), []);
  const closeBuy = useCallback(() => setBuying(null), []);
  const closeSchedule = useCallback(() => setScheduling(null), []);

  if (!brandId) return <p className="ad-error">ร้านนี้ยังไม่อยู่ในแบรนด์</p>;
  if (error && !wallet) return <section className="ad-card"><p className="ad-error" role="alert">{error}</p><p className="ad-muted">หน้านี้สำหรับเจ้าของแบรนด์เท่านั้น</p></section>;
  if (!wallet) return <p className="ad-muted">กำลังโหลด…</p>;

  const { catalog } = wallet;
  const state = wallet.plan;
  const plan = catalog.plans.find((p) => p.id === state.effective) ?? catalog.plans[0];
  const paid = plan.monthly > 0;
  const ownCycle = state.cycle === "year" ? "year" : "month";
  const renewPlan = catalog.plans.find((p) => p.id === (state.next_plan && state.next_plan !== "free" ? state.next_plan : plan.id)) ?? plan;
  const renewCycle = state.next_cycle ?? ownCycle;
  const renewPrice = renewCycle === "year" ? renewPlan.yearly : renewPlan.monthly;
  const months = paid && renewPrice ? Math.floor(wallet.balance / renewPrice) : 0;
  const daysLeft = wallet.planDaysLeft;
  const inGrace = paid && daysLeft != null && daysLeft <= 0 && state.grace_until;
  const willRenew = paid && !state.complimentary && state.auto_renew !== false && state.next_plan !== "free";
  const soon = paid && !state.complimentary && daysLeft != null && daysLeft <= 7;
  const pending = wallet.topups.filter((t) => t.status === "pending");
  const quota = wallet.quota;
  const shortBy = Math.max(0, Math.ceil(renewPrice - wallet.balance));
  const pickPlan = (p, quote, c) => setBuying({ sku: c === "year" ? `plan:${p.id}:year` : `plan:${p.id}`, label: `แพ็กเกจ${p.name} ${cycleWord(c)}`, amount: quote.amount, full: c === "year" ? p.yearly : p.monthly, plan: p.id, quote });

  async function setAutoRenew(on) {
    setBusy(true);
    try {
      await api("PUT", `/api/dashboard/brands/${brandId}/wallet/plan`, on ? { autoRenew: true, nextPlan: state.next_plan === "free" ? null : state.next_plan } : { autoRenew: false });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancelScheduled() {
    setBusy(true);
    try {
      await api("PUT", `/api/dashboard/brands/${brandId}/wallet/plan`, { autoRenew: true, nextPlan: null, nextCycle: null });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const scheduledName = state.next_plan && state.next_plan !== "free" ? catalog.plans.find((p) => p.id === state.next_plan)?.name : null;
  return (
    <div className="ad-stack bl-page">
      {error && <p className="ad-error" role="alert">{error}</p>}
      {state.trial && state.complimentary && state.valid_until && daysLeft > 0 && (
        <p className="bl-alert" data-tone="gift">
          🎁 กำลังทดลองใช้แพ็กเกจ{plan.name}ฟรี เหลืออีก {daysLeft} วัน (ถึง {thDate(state.valid_until)})
          <small>ไม่ตัดเงิน · ครบแล้วกลับเป็นแพ็กเกจฟรีเอง ข้อมูลอยู่ครบ · เลือกแพ็กเกจด้านล่างเพื่อใช้ต่อ วันใช้งานต่อจากวันทดลองหมด</small>
        </p>
      )}
      {state.complimentary && !state.trial && state.valid_until && (
        <p className="bl-alert" data-tone="gift">
          🎁 ร้านของคุณใช้แพ็กเกจ{plan.name}ฟรีถึง {thDate(state.valid_until)} · ไม่ตัดเงินจากกระเป๋า · หลังจากนั้นกลับเป็นแพ็กเกจฟรี ถ้ายังไม่ได้เลือกแพ็กเกจ
          <small>ซื้อแพ็กเกจ{plan.name}ล่วงหน้าได้ วันใช้งานจะต่อจากวันที่ใช้ฟรีหมด</small>
        </p>
      )}
      {inGrace && (
        <p className="bl-alert" data-tone="warn">
          แพ็กเกจ{plan.name}หมดอายุแล้ว · ใช้ต่อได้ถึง {thDate(state.grace_until)} (ช่วงผ่อนผัน) · เติมเงินอีก {money(shortBy)} บาท ระบบจะต่ออายุให้ภายในชั่วโมง
          <button type="button" className="ad-link" onClick={() => setTopup(Math.max(wallet.limits.min, shortBy))}>เติมเงิน</button>
        </p>
      )}
      {soon && !inGrace && willRenew && (
        <p className="bl-alert" data-tone={wallet.balance >= renewPrice ? "info" : "warn"}>
          {`แพ็กเกจ${plan.name}จะต่ออายุในอีก ${Math.max(daysLeft, 0)} วัน`}
          {wallet.balance >= renewPrice ? " · ระบบจะตัดจากกระเป๋าให้อัตโนมัติ" : ` · เติมเงินอีก ${money(shortBy)} บาทเพื่อต่ออายุ`}
          {wallet.balance < renewPrice && <button type="button" className="ad-link" onClick={() => setTopup(Math.max(wallet.limits.min, shortBy))}>เติมเงิน</button>}
        </p>
      )}

      <div className="bl-top">
        <section className="ad-card bl-current">
          <div className="bl-current-head">
            <div>
              <p className="ad-muted">แพ็กเกจปัจจุบัน</p>
              <h2>{plan.name}{paid && !state.complimentary ? <small className="bl-cycle"> · {ownCycle === "year" ? "รายปี" : "รายเดือน"}</small> : null}</h2>
              <p className="ad-muted">{paid ? (state.valid_until ? `ใช้ได้ถึง ${thDate(state.valid_until)}${daysLeft > 0 ? ` (อีก ${daysLeft} วัน)` : ""}` : "ไม่มีวันหมดอายุ") : "ใช้ได้ไม่มีค่าใช้จ่าย"}</p>
            </div>
            {paid && state.complimentary && <span className="ad-status" data-tone="info">{state.trial ? "ทดลองใช้ฟรี" : "ข้อเสนอเปิดตัว · ใช้ฟรี"}</span>}
            {paid && !state.complimentary && (
              <label className="ad-switch bl-autorenew">
                <input type="checkbox" role="switch" checked={willRenew} disabled={busy} onChange={(e) => setAutoRenew(e.target.checked)} />
                <span aria-hidden="true" />
                ต่ออายุอัตโนมัติ
              </label>
            )}
          </div>
          {paid && !state.complimentary && (scheduledName || state.next_plan === "free" || (state.next_cycle && state.next_cycle !== ownCycle)) && (
            <p className="bl-scheduled">
              {state.next_plan === "free" || state.auto_renew === false
                ? `ไม่ต่ออายุ · กลับเป็นแพ็กเกจฟรี ${thDate(state.valid_until)}`
                : `รอบถัดไป (${thDate(state.valid_until)}) เปลี่ยนเป็นแพ็กเกจ${scheduledName ?? plan.name} ${state.next_cycle === "year" ? "รายปี" : "รายเดือน"} · ${money(renewPrice)} บาท`}
              <button type="button" className="ad-link" disabled={busy} onClick={cancelScheduled}>ยกเลิก</button>
            </p>
          )}
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
          <p className="ad-muted">{state.complimentary || !paid ? "ใช้ซื้อแพ็กเกจและแพ็กเสริม" : willRenew ? (months > 0 ? `พอต่ออายุได้อีก ${months} รอบ` : `ยังไม่พอต่ออายุรอบหน้า (${money(renewPrice)} บาท)`) : "ไม่ได้ตั้งต่ออายุอัตโนมัติ"}</p>
          <button type="button" className="ad-primary" onClick={() => setTopup(willRenew && shortBy > 0 ? Math.max(wallet.limits.min, shortBy) : 1000)}>เติมเงิน</button>
          {pending.length > 0 && <p className="bl-pending">⏳ สลิปรอตรวจ {pending.length} ใบ · รวม {money(pending.reduce((s, t) => s + t.amount, 0))} บาท</p>}
          <p className="bl-wallet-note">โอนผ่านพร้อมเพย์แล้วแนบสลิป · ตรวจอัตโนมัติ เงินเข้าทันที</p>
        </section>
      </div>

      <section className="ad-card">
        <div className="ad-card-head bl-plans-head">
          <div><h2>เลือกแพ็กเกจ</h2><p className="ad-muted">ทุกแพ็กเกจได้ {catalog.everyPlan.join(" · ")} · ราคายังไม่รวม VAT</p></div>
          <div className="bl-cycle-toggle" role="group" aria-label="รอบการจ่าย">
            <button type="button" aria-pressed={cycle === "month"} onClick={() => setCycle("month")}>รายเดือน</button>
            <button type="button" aria-pressed={cycle === "year"} onClick={() => setCycle("year")}>รายปี <small>ประหยัด 2 เดือน</small></button>
          </div>
        </div>
        <PlanCards wallet={wallet} cycle={cycle} onPick={pickPlan} onSchedule={setScheduling} />
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
      {scheduling && <ScheduleSheet brandId={brandId} wallet={wallet} target={scheduling} onClose={closeSchedule} onDone={load} />}
      {buying && <BuySheet brandId={brandId} wallet={wallet} item={buying} onClose={closeBuy} onDone={load} onTopup={(amount) => { setBuying(null); setTopup(amount); }} />}
    </div>
  );
}
