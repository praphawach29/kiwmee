// Desktop-only navigation. Narrow screens keep their existing dashboard navigation.
export default function MerchantSidebar({ groups, active, onSelect, name, role, onSignOut, signingOut = false }) {
  const item = ({ id, label, icon, href }) => {
    const props = {
      className: "merchant-nav" + (active === id ? " is-active" : ""),
      "aria-current": active === id ? "page" : undefined,
    };
    const content = <><span className="merchant-nav-icon" aria-hidden="true">{icon}</span><span>{label}</span></>;
    return href
      ? <a key={id} {...props} href={href}>{content}</a>
      : <button key={id} type="button" {...props} onClick={() => onSelect(id)}>{content}</button>;
  };

  return <aside className="merchant-sidebar" aria-label="เมนูจัดการร้าน">
    <a href="/dashboard" className="merchant-logo" aria-label="Kiwmee ร้านทั้งหมด"><img src="/brand/kiwmee-logo.svg" alt="kiwmee" width="128" height="40" /><span>ร้านค้า</span></a>
    <p className="merchant-sidebar-caption">พื้นที่จัดการร้านของคุณ</p>
    <nav aria-label="เมนูหลักร้านค้า">
      {groups.map((group) => <div className="merchant-nav-group" key={group.label}>
        {group.collapsible ? <details open className="merchant-settings">
          <summary>{group.label}<span aria-hidden="true">⌄</span></summary>
          <div className="merchant-subnav">{group.items.map(item)}</div>
        </details> : <><p className="merchant-group-label">{group.label}</p>{group.items.map(item)}</>}
      </div>)}
    </nav>
    <div className="merchant-sidebar-footer">
      <div className="merchant-identity"><span className="merchant-avatar" aria-hidden="true">{name?.[0]?.toUpperCase() || "K"}</span><div><b>{name}</b><span>{role}</span></div></div>
      {onSignOut && <button type="button" className="merchant-nav" disabled={signingOut} onClick={onSignOut}><span className="merchant-nav-icon" aria-hidden="true">↪</span>{signingOut ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}</button>}
    </div>
  </aside>;
}
