// Presentation only: the booking engine remains the source of selections and next steps.
export function ShopHeader({ shop, subtitle }) {
  return (
    <header className="bk-header bk-shop-header">
      <span className="bk-shop-monogram" aria-hidden="true">{shop.name?.[0]}</span>
      <div><p className="bk-eyebrow">จองกับร้าน</p><h1>{shop.name}</h1><p className="bk-muted">{subtitle}</p></div>
    </header>
  );
}

export function BookingProgress({ phase }) {
  const phases = [{ key: "selection", label: "เลือกคิว" }, { key: "customer", label: "ข้อมูลผู้จอง" }, { key: "complete", label: "ยืนยัน" }];
  const current = phases.findIndex((item) => item.key === phase);
  return (
    <ol className="bk-progress" aria-label="ภาพรวมการจอง">
      {phases.map((item, index) => <li key={item.key} aria-current={phase === item.key ? "step" : undefined} data-done={index < current}><span aria-hidden="true">{index < current ? "✓" : index + 1}</span>{item.label}</li>)}
    </ol>
  );
}

export function BookingReview({ items, onEdit, busy }) {
  return (
    <section className="bk-card bk-review" aria-labelledby="booking-review-title">
      <div><p className="bk-eyebrow">ก่อนยืนยัน</p><h2 id="booking-review-title">สรุปการจอง</h2><p className="bk-muted">ตรวจสอบวันเวลาและบริการที่เลือก</p></div>
      <dl className="bk-summary">
        {items.map((item) => <div key={item.step}><dt>{item.label}</dt><dd><strong>{item.value}</strong><button type="button" className="bk-text-button" disabled={busy} onClick={() => onEdit(item.step)} aria-label={`เปลี่ยน${item.label}`}>เปลี่ยน</button></dd></div>)}
      </dl>
    </section>
  );
}

export function BookingSubmitBar({ formId, disabled, busy }) {
  return (
    <div className="bk-submit-bar">
      <div className="bk-submit-copy"><strong>พร้อมยืนยันการจอง</strong><span>ตรวจสอบรายละเอียดและข้อมูลติดต่อ</span></div>
      <button type="submit" form={formId} className="bk-primary" disabled={disabled}>
        {busy ? "กำลังยืนยัน…" : "ยืนยันการจอง"}
      </button>
    </div>
  );
}
