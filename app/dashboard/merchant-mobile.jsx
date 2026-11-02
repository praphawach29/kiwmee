"use client";

// Phone navigation for one shop: a compact header and a bottom tab bar (the desktop sidebar is hidden
// below 1100px). The tabs come from the same role-checked navigation as the sidebar.
import { useEffect, useState } from "react";

const SHORT = { bills: "บิล" };
const ICONS = {
  overview: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  bookings: <><rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></>,
  bills: <><path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>
};
const Icon = ({ id }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[id]}
  </svg>
);

export function MobileShopHeader({ name, subtitle, bell }) {
  return (
    <header className="merchant-mobile-top">
      <a href="/dashboard" className="merchant-mobile-mark" aria-label="ร้านทั้งหมด">{name?.[0] ?? "K"}</a>
      <div className="merchant-mobile-title">
        <strong>{name}</strong>
        <span>{subtitle}</span>
      </div>
      {bell}
    </header>
  );
}

// groups: shopNavigation(role); the first daily items are tabs, everything else lives under "เพิ่มเติม"
export function MobileTabBar({ groups, active, onSelect, badges = {}, bookingHref, onSignOut, signingOut }) {
  const [open, setOpen] = useState(false);
  const daily = groups.find((g) => g.label === "จัดการประจำวัน")?.items ?? [];
  const rest = groups.filter((g) => g.label !== "จัดการประจำวัน" && g.label !== "ภาพรวม").flatMap((g) => g.items);
  const moreActive = rest.some((item) => item.id === active);

  useEffect(() => {
    if (!open) return;
    const close = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (daily.length === 0 && rest.length === 0) return null;
  const pick = (id) => {
    setOpen(false);
    onSelect(id);
  };

  return (
    <>
      <nav className="merchant-tabbar" aria-label="เมนูหลักร้านค้า">
        {daily.map((item) => (
          <button key={item.id} type="button" aria-current={active === item.id ? "page" : undefined} onClick={() => pick(item.id)}>
            <span className="merchant-tabbar-icon">
              <Icon id={item.id} />
              {badges[item.id] > 0 && <span className="merchant-tabbar-badge" aria-label={`${badges[item.id]} รายการใหม่`}>{badges[item.id] > 99 ? "99+" : badges[item.id]}</span>}
            </span>
            {SHORT[item.id] ?? item.label}
          </button>
        ))}
        <button type="button" aria-current={moreActive ? "page" : undefined} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="merchant-tabbar-icon"><Icon id="more" /></span>
          เพิ่มเติม
        </button>
      </nav>
      {open && (
        <>
          <button type="button" className="merchant-sheet-backdrop" aria-label="ปิดเมนู" onClick={() => setOpen(false)} />
          <div className="merchant-sheet" role="dialog" aria-label="เมนูเพิ่มเติม">
            {rest.length > 0 && (
              <>
                <p className="merchant-sheet-label">ตั้งค่าร้าน</p>
                {rest.map((item) => (
                  <button key={item.id} type="button" className="merchant-sheet-item" aria-current={active === item.id ? "page" : undefined} onClick={() => pick(item.id)}>
                    <span aria-hidden="true">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </>
            )}
            <p className="merchant-sheet-label">อื่น ๆ</p>
            <a className="merchant-sheet-item" href={bookingHref} target="_blank" rel="noreferrer"><span aria-hidden="true">↗</span>เปิดหน้าจองลูกค้า</a>
            <a className="merchant-sheet-item" href="/dashboard"><span aria-hidden="true">⌂</span>ร้านทั้งหมด</a>
            {onSignOut && (
              <button type="button" className="merchant-sheet-item" disabled={signingOut} onClick={onSignOut}>
                <span aria-hidden="true">↪</span>
                {signingOut ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
