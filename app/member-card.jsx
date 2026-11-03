"use client";

// The membership card (docs/LOYALTY_DESIGN.md §3.1): the member's LINE page shows theirs, the shop's
// dashboard shows a preview of each tier. Colours by tier (src/v2/tier-themes.js).
import { themeOf } from "../src/v2/tier-themes.js";
import "./member-card.css";

// only an uploaded image (Storage, https) or a bundled demo picture
const safeLogo = (url) => typeof url === "string" && (/^https:\/\/[^\s"'<>]+$/.test(url) || /^\/demo-media\/[A-Za-z0-9._/-]+$/.test(url));

export function MemberCardFace({ programName, shopName, tierName = null, theme = "classic", balance = 0, rule = "", multiplier = 1, next = null, logoUrl = null, children = null }) {
  const t = themeOf(theme);
  return (
    <div className="mc-card" data-theme={theme} style={{ "--mc-from": t.from, "--mc-to": t.to, "--mc-text": t.text, "--mc-accent": t.accent }}>
      <span className="mc-shine" aria-hidden="true" />
      <div className="mc-top">
        <span className="mc-brand">
          {safeLogo(logoUrl) && <img className="mc-logo" src={logoUrl} alt="" width="36" height="36" />}
          <span className="mc-program">{shopName ? `${shopName} · ` : ""}{programName}</span>
        </span>
        {tierName && <span className="mc-tier">{tierName} ✦</span>}
      </div>
      <strong className="mc-balance">{Number(balance).toLocaleString("th-TH")} <small>คะแนน</small></strong>
      {(rule || multiplier > 1) && <span className="mc-rule">{rule}{multiplier > 1 ? ` · ระดับนี้ได้ ×${multiplier}` : ""}</span>}
      {next && (
        <div className="mc-next">
          <span className="mc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(next.progress * 100)} aria-label={next.text}>
            <i style={{ width: `${Math.max(Math.min(next.progress, 1), 0.03) * 100}%` }} />
          </span>
          <small>{next.text}</small>
        </div>
      )}
      {children}
    </div>
  );
}
