"use client";

// "การจองของฉัน" (/b/<slug>/me): Customer Portal & Loyalty Flow
// Integrated with Stitch LINE OA Booking Interface (Screens 7, 9, 13):
// - Screen 7: เช็คคิวของฉัน (My Bookings)
// - Screen 9: คูปองของฉัน (My Vouchers)
// - Screen 13: บัตรสมาชิก & สะสมแต้ม (Kiwmee Member & Rewards)

import { useEffect, useRef, useState } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { CustomerTabs, DirectionsButton, ShopHeader, ShopHero, withMedia, ResourceThumbnail } from "../booking-presentation.jsx";
import { useLiff } from "../use-liff.jsx";
import { CheckinQr, QrImage } from "../qr.jsx";
import { MemberCardFace } from "../../../member-card.jsx";
import { scanUrl, bookingCode } from "../../../../src/v2/scan-codes.js";

const STATUS = {
  held: "รอโอนมัดจำ",
  pending: "รอร้านตรวจสลิป",
  confirmed: "ยืนยันแล้ว",
  checked_in: "มาถึงแล้ว",
  completed: "ใช้บริการแล้ว",
  cancelled: "ยกเลิกแล้ว",
  no_show: "ไม่ได้มาตามนัด",
  expired: "หมดเวลาชำระ"
};

const KIND_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };

const part = (date, opts) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));
const money = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;

function icsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
}
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function downloadIcs(booking, shop) {
  const service = booking.offering || "นัดหมาย";
  const startIso = booking.startAt || `${booking.date}T${booking.start}:00Z`;
  const endIso = booking.endAt || `${booking.endDate || booking.date}T${booking.end}:00Z`;
  const link = booking.link ? new URL(booking.link, window.location.origin).toString() : window.location.href;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kiwmee//Booking//TH",
    "BEGIN:VEVENT",
    `UID:${booking.id || Date.now()}@kiwmee`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(startIso)}`,
    `DTEND:${icsTime(endIso)}`,
    `SUMMARY:${icsText(`${service} · ${shop.name}`)}`,
    `DESCRIPTION:${icsText(`ดูหรือเปลี่ยนนัด: ${link}`)}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${shop.slug}-booking.ics` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DateTile({ date, small = false }) {
  return (
    <span className="bk-date-tile" data-small={small || undefined} aria-hidden="true">
      <small>{part(date, { month: "short" })}</small>
      <strong>{part(date, { day: "numeric" })}</strong>
    </span>
  );
}

// ============================================================
// SCREEN 7: NEXT BOOKING (HERO CARD)
// ============================================================
function NextBooking({ booking, directions, slug, shop }) {
  const resource = booking.resources?.[0];
  const code = bookingCode(booking.id || booking.checkin);
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(`#KM-${code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="bk-next bk-pass-card" aria-label="นัดถัดไป">
      {/* Header: Status & Countdown */}
      <div className="bk-next-head">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="bk-next-eyebrow">นัดถัดไป</span>
          <span className="bk-status" data-status={booking.status}>
            {STATUS[booking.status] ?? booking.status}
          </span>
        </div>
        <span className="bk-duration-tag">
          {part(booking.date, { weekday: "short", day: "numeric", month: "short" })}
        </span>
      </div>

      {/* Booking Code with Copy Action */}
      <div className="bk-code-row">
        <span>รหัสการจอง: <strong>#KM-{code}</strong></span>
        <button type="button" className="bk-text-button" onClick={copyCode} style={{ padding: 0, minHeight: 0 }}>
          {copied ? "คัดลอกแล้ว!" : "คัดลอก"}
        </button>
      </div>

      {/* Date & Time Large Block */}
      <div className="bk-when">
        <DateTile date={booking.date} />
        <div>
          <strong>{part(booking.date, { weekday: "long" })}</strong>
          <span>
            <span className="bk-nowrap">{part(booking.date, { day: "numeric", month: "short", year: "numeric" })}</span> ·{" "}
            {booking.endDate && booking.endDate !== booking.date ? (
              <>
                <span className="bk-nowrap">รับ {booking.start} น.</span> ·{" "}
                <span className="bk-nowrap">คืน {part(booking.endDate, { weekday: "short", day: "numeric", month: "short" })} {booking.end} น.</span>
              </>
            ) : (
              <span className="bk-nowrap">{booking.start}–{booking.end} น.</span>
            )}
          </span>
        </div>
      </div>

      {/* Stylist & Location Preview */}
      {resource && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg)", borderRadius: 12 }}>
          <ResourceThumbnail resource={resource} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong style={{ display: "block", fontSize: ".92rem", color: "var(--ink)" }}>{resource.name}</strong>
            <small className="bk-muted">{KIND_WORD[resource.kind] ?? "ผู้ให้บริการ"} · คิวพร้อมบริการ</small>
          </div>
          <span className="bk-time-badge bk-time-free">PRO</span>
        </div>
      )}

      {/* Details dl */}
      <dl className="bk-summary">
        <div>
          <dt>บริการ</dt>
          <dd>{booking.offering}</dd>
        </div>
        {booking.total > 0 && (
          <div>
            <dt>ราคา</dt>
            <dd><strong>{money(booking.total)}</strong></dd>
          </div>
        )}
        {booking.points && (
          <div>
            <dt>ใช้คะแนน</dt>
            <dd>{booking.points.name} (ลด {money(booking.points.discountBaht)})</dd>
          </div>
        )}
      </dl>

      {/* Check-in QR */}
      {booking.checkin && (
        <div className="bk-done-qr">
          <CheckinQr slug={slug} id={booking.checkin} open={true} />
        </div>
      )}
      {!booking.checkin && ["held", "pending"].includes(booking.status) && <p className="bk-qr-wait">QR เช็กอินจะแสดงเมื่อร้านยืนยันมัดจำแล้ว</p>}

      {/* Action Buttons */}
      <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
        {booking.link && (
          <a className="bk-primary" href={booking.link} style={{ justifyContent: "center", textDecoration: "none" }}>
            {booking.status === "held" ? "แนบสลิปโอนมัดจำ" : "ดู เลื่อน หรือยกเลิกนัด"}
          </a>
        )}

        <button type="button" className="bk-secondary bk-cal-btn" onClick={() => downloadIcs(booking, shop || { slug, name: "Kiwmee" })}>
          📅 บันทึกลงปฏิทิน
        </button>

        {booking.link && (
          <div className="bk-action-grid">
            <a className="bk-secondary" href={booking.link} style={{ justifyContent: "center", textDecoration: "none" }}>
              เลื่อนนัดหมาย
            </a>
            <a className="bk-secondary" href={booking.link} style={{ justifyContent: "center", textDecoration: "none", color: "var(--danger)" }}>
              ยกเลิกการจอง
            </a>
          </div>
        )}
      </div>

      <DirectionsButton href={directions} />
      <p className="bk-fine" style={{ textAlign: "center", margin: "2px 0 0" }}>
        * เลื่อนหรือยกเลิกเองได้ตามนโยบายของร้านผ่านลิงก์การจอง
      </p>
    </article>
  );
}

function BookingRow({ booking, shopSlug }) {
  const isCompleted = booking.status === "completed";
  const body = (
    <>
      <DateTile date={booking.date} small />
      <span className="bk-row-text">
        <strong>{booking.offering}</strong>
        <small className="bk-row-time">
          {part(booking.date, { weekday: "short" })}{" "}
          {booking.endDate && booking.endDate !== booking.date ? (
            <><span className="bk-nowrap">{booking.start} น.</span> <span className="bk-nowrap">→ คืน {part(booking.endDate, { day: "numeric", month: "short" })}</span></>
          ) : (
            <span className="bk-nowrap">{booking.start}–{booking.end} น.</span>
          )}
        </small>
        {booking.resources?.length > 0 && <small>{booking.resources.map((r) => r.name).join(", ")}</small>}
      </span>
      <span className="bk-status" data-status={booking.status}>
        {STATUS[booking.status] ?? booking.status}
      </span>
    </>
  );

  return (
    <li>
      <div style={{ display: "grid", gap: 6, padding: "8px 0" }}>
        {booking.link ? <a className="bk-booking-row" href={booking.link}>{body}</a> : <div className="bk-booking-row">{body}</div>}
        {isCompleted && shopSlug && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingLeft: 56 }}>
            <a
              href={`/b/${shopSlug}/review/${booking.id || "demo"}`}
              style={{
                minHeight: 32,
                padding: "4px 12px",
                fontSize: ".8rem",
                textDecoration: "none",
                borderRadius: "10px",
                background: "var(--selected)",
                color: "var(--grape-deep)",
                border: "1px solid var(--grape)",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "4px"
              }}
            >
              ⭐ รีวิวบริการ (+50 แต้ม)
            </a>
            <a className="bk-secondary" href={`/b/${shopSlug}`} style={{ minHeight: 32, padding: "4px 10px", fontSize: ".8rem", textDecoration: "none" }}>
              จองซ้ำ (Rebook)
            </a>
          </div>
        )}
      </div>
    </li>
  );
}

// ============================================================
// SCREEN 9: MY VOUCHERS
// ============================================================
const INITIAL_VOUCHERS = [
  {
    code: "COMEBACK10",
    title: "ส่วนลดพิเศษ Comeback 10%",
    tags: ["LINE Exclusive", "สิทธิ์ปลอบใจ"],
    amount: "-10%",
    detail: "ลดสูงสุด ฿250 ทุกรายการบริการ • ไม่มีขั้นต่ำ",
    expiry: "หมดอายุ 30 เม.ย. (เหลือ 14 วัน)",
    status: "active"
  },
  {
    code: "WELCOME150",
    title: "คูปองต้อนรับสมาชิกใหม่",
    tags: ["Welcome Kiwmee"],
    amount: "-฿150",
    detail: "ส่วนลดเงินสด ฿150 เมื่อจองขั้นต่ำ ฿600",
    expiry: "หมดอายุ 31 พ.ค. 2568",
    status: "active"
  },
  {
    code: "BIRTHDAY20",
    title: "ของขวัญเดือนเกิด สุขสันต์วันเกิด",
    tags: ["VIP Birthday"],
    amount: "-20%",
    detail: "รับสิทธิ์ทำผมหรือทรีตเมนต์ลด 20% ตลอดเดือนเกิด",
    expiry: "หมดอายุสิ้นเดือนเกิด",
    status: "active"
  },
  {
    code: "SPA100",
    title: "ส่วนลดสปาผม Olaplex",
    tags: ["Hair Spa"],
    amount: "-฿100",
    detail: "ส่วนลด ฿100 สำหรับ Olaplex Spa & Treatment",
    expiry: "ใช้แล้วเมื่อ 14 ก.พ. 2568",
    status: "used"
  },
  {
    code: "NEWYEAR25",
    title: "ต้อนรับปีใหม่ New Year Gift",
    tags: ["Festival"],
    amount: "-15%",
    detail: "ส่วนลดพิเศษช่วงเทศกาลปีใหม่",
    expiry: "หมดอายุเมื่อ 31 ม.ค. 2568",
    status: "expired"
  }
];

function VouchersView({ slug }) {
  const [vouchers, setVouchers] = useState(INITIAL_VOUCHERS);
  const [filter, setFilter] = useState("active");
  const [promoInput, setPromoInput] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [copied, setCopied] = useState(null);

  const activeCount = vouchers.filter((v) => v.status === "active").length;
  const usedCount = vouchers.filter((v) => v.status === "used").length;
  const expiredCount = vouchers.filter((v) => v.status === "expired").length;

  function applyPromo(e) {
    e.preventDefault();
    const clean = promoInput.trim().toUpperCase();
    if (!clean) return;
    const existing = vouchers.find((v) => v.code === clean);
    if (existing) {
      setFeedback(`มีคูปองโค้ด ${clean} อยู่ในกระเป๋าของคุณแล้ว!`);
    } else {
      const newVoucher = {
        code: clean,
        title: `คูปองส่วนลดพิเศษ (${clean})`,
        tags: ["Promo Code"],
        amount: "-10%",
        detail: "ส่วนลดพิเศษจากการแลกโค้ด • ใช้ร่วมกับการจองคิว",
        expiry: "หมดอายุ 30 วันหลังเปิดใช้งาน",
        status: "active"
      };
      setVouchers([newVoucher, ...vouchers]);
      setFeedback(`แลกรับสิทธิ์สำเร็จแล้ว! คูปอง ${clean} ถูกเพิ่มในกระเป๋าของคุณ`);
      setPromoInput("");
    }
  }

  async function copyCode(code) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  const shownVouchers = vouchers.filter((v) => v.status === filter);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Summary Banner Card */}
      <section className="bk-card" style={{ padding: 18 }}>
        <div className="bk-row">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>🎟️</span>
            <div>
              <span className="bk-eyebrow">กระเป๋าสิทธิพิเศษ</span>
              <h2 style={{ margin: 0 }}>คูปองของฉัน</h2>
            </div>
          </div>
          <span className="bk-time-badge bk-time-free">พร้อมใช้ {activeCount} ใบ</span>
        </div>

        {/* Mini Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 4 }}>
          <div style={{ textAlign: "center", padding: "8px 4px", borderRadius: 12, background: "var(--bg)" }}>
            <strong style={{ display: "block", fontSize: "1.25rem", color: "var(--grape-deep)" }}>{activeCount}</strong>
            <small className="bk-muted">พร้อมใช้</small>
          </div>
          <div style={{ textAlign: "center", padding: "8px 4px", borderRadius: 12, background: "var(--bg)" }}>
            <strong style={{ display: "block", fontSize: "1.25rem", color: "var(--muted)" }}>{usedCount}</strong>
            <small className="bk-muted">ใช้แล้ว</small>
          </div>
          <div style={{ textAlign: "center", padding: "8px 4px", borderRadius: 12, background: "var(--bg)" }}>
            <strong style={{ display: "block", fontSize: "1.25rem", color: "var(--danger)" }}>{expiredCount}</strong>
            <small className="bk-muted">หมดอายุ</small>
          </div>
        </div>

        {/* Promo Code Input */}
        <form onSubmit={applyPromo} style={{ marginTop: 8 }}>
          <label style={{ display: "block", fontSize: ".82rem", color: "var(--muted)", marginBottom: 4 }}>
            มีโค้ดส่วนลดพิเศษหรือไม่?
          </label>
          <div className="bk-promo-input-row">
            <input
              type="text"
              className="bk-promo-input"
              placeholder="กรอกโค้ด เช่น COMEBACK10"
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value)}
            />
            <button type="submit" className="bk-promo-btn">แลกโค้ด</button>
          </div>
          {feedback && (
            <p className="bk-notice" style={{ marginTop: 8, fontSize: ".84rem" }}>
              ✓ {feedback}
            </p>
          )}
        </form>
      </section>

      {/* Segmented Filter */}
      <div className="bk-filter-segmented">
        <button type="button" className="bk-filter-btn" data-active={filter === "active"} onClick={() => setFilter("active")}>
          <span>พร้อมใช้งาน</span>
          <span className="bk-pill-count">{activeCount}</span>
        </button>
        <button type="button" className="bk-filter-btn" data-active={filter === "used"} onClick={() => setFilter("used")}>
          <span>ใช้แล้ว</span>
          <span className="bk-pill-count">{usedCount}</span>
        </button>
        <button type="button" className="bk-filter-btn" data-active={filter === "expired"} onClick={() => setFilter("expired")}>
          <span>หมดอายุ</span>
          <span className="bk-pill-count">{expiredCount}</span>
        </button>
      </div>

      {/* Voucher Stream */}
      <div style={{ display: "grid", gap: 12 }}>
        {shownVouchers.length === 0 ? (
          <p className="bk-empty">ไม่มีคูปองในหมวดนี้</p>
        ) : (
          shownVouchers.map((v) => (
            <article key={v.code} className="bk-voucher-card">
              <div className="bk-voucher-header">
                <div>
                  <div className="bk-voucher-tags">
                    {v.tags.map((tag, i) => (
                      <span key={tag} className={i === 1 ? "bk-voucher-tag bk-voucher-tag-special" : "bk-voucher-tag"}>
                        {tag}
                      </span>
                    ))}
                  </div>
                  <h3 style={{ margin: "6px 0 0", fontSize: "1.05rem", fontWeight: 700, color: "var(--ink)" }}>{v.title}</h3>
                </div>
                <span className="bk-voucher-amount">{v.amount}</span>
              </div>

              <p style={{ margin: 0, fontSize: ".84rem", color: "var(--muted)", lineHeight: 1.5 }}>
                {v.detail}
              </p>

              <div className="bk-voucher-notch" aria-hidden="true">
                <span className="bk-voucher-dash" />
              </div>

              <div className="bk-voucher-footer">
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: ".76rem", color: "var(--muted)" }}>รหัสคูปอง:</span>
                    <strong style={{ fontFamily: "var(--font-display)", color: "var(--grape-deep)", letterSpacing: ".04em" }}>{v.code}</strong>
                    <button type="button" className="bk-text-button" onClick={() => copyCode(v.code)} style={{ padding: "0 4px", minHeight: 0, fontSize: ".78rem" }}>
                      {copied === v.code ? "คัดลอกแล้ว!" : "คัดลอก"}
                    </button>
                  </div>
                  <small style={{ display: "block", fontSize: ".74rem", color: v.status === "active" ? "var(--warn)" : "var(--muted)", marginTop: 2 }}>
                    ⏱ {v.expiry}
                  </small>
                </div>
                {v.status === "active" && (
                  <a className="bk-primary" href={`/b/${slug}`} style={{ minHeight: 38, padding: "0 14px", fontSize: ".84rem", textDecoration: "none", flex: "none" }}>
                    ใช้จองคิว →
                  </a>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// SCREEN 13: KIWMEE MEMBER & REWARDS
// ============================================================
const KIND = { earn: "ได้คะแนน", redeem: "ใช้คะแนน", release: "คืนคะแนน", reverse: "หักคืน (คืนเงิน)", adjust: "ร้านปรับคะแนน" };

function MemberRewardsView({ points, slug, idToken }) {
  const [code, setCode] = useState(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");
  const [cat, setCat] = useState("all");
  const historyRef = useRef(null);
  const perksRef = useRef(null);
  const rewardsRef = useRef(null);

  useEffect(() => {
    if (!code) return undefined;
    const tick = () => {
      const s = Math.max(Math.round((code.until - Date.now()) / 1000), 0);
      setLeft(s);
      if (s === 0) setCode(null);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code]);

  async function showCode() {
    setError("");
    try {
      const response = await fetch(`/api/b/${slug}/me/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineIdToken: idToken }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "ขอรหัสไม่สำเร็จ กรุณาลองใหม่");
      setCode({ code: payload.data.code, until: Date.now() + payload.data.expiresInSeconds * 1000 });
    } catch (e) {
      setError(e.message);
    }
  }

  const visits = points.tier?.visits ?? 6;
  const currentStamps = (visits % 10) || 6;
  const bahtEquivalent = Math.floor(points.balance / 10);

  const rewards = points.rewards ?? [];
  const shownRewards = rewards.filter((r) => {
    if (cat === "all") return true;
    if (cat === "discount") return r.kind !== "free_offering";
    if (cat === "service") return r.kind === "free_offering";
    return true;
  });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Interactive Member Card Hero */}
      <MemberCardFace
        programName={points.name}
        tierName={points.tier?.name}
        theme={points.tier?.cardTheme ?? "classic"}
        balance={points.balance}
        rule={points.rule}
        multiplier={points.tier?.earnMultiplier ?? 1}
        next={points.tier?.next ?? null}
        logoUrl={points.logoUrl}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <span style={{ fontSize: ".82rem", opacity: .9 }}>แทนส่วนลด ฿{bahtEquivalent.toLocaleString("th-TH")} (10 แต้ม = 1 บาท)</span>
        </div>
        {points.expiring > 0 && points.expiringAt && (
          <span className="bk-points-expiring">
            {points.expiring} คะแนนจะหมดอายุ {new Date(points.expiringAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}
          </span>
        )}
        {code ? (
          <div className="bk-points-code" aria-live="polite">
            <small>ให้พนักงานสแกน หรือบอกรหัสนี้ตอนจ่ายเงิน</small>
            <QrImage text={scanUrl(window.location.origin, slug, "m", code.code)} label={`QR สมาชิก รหัส ${code.code}`} size={168} />
            <strong>{code.code.slice(0, 3)} {code.code.slice(3)}</strong>
            <small>ใช้ได้อีก {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} นาที · ใช้ได้ครั้งเดียว</small>
          </div>
        ) : (
          <button type="button" className="bk-points-button" onClick={showCode}>
            แตะแสดง QR สมาชิก (ตอนจ่ายที่ร้าน)
          </button>
        )}
        {error && <span className="bk-points-error" role="alert">{error}</span>}
      </MemberCardFace>

      {/* Quick Action Navigation Hub */}
      <div className="bk-action-hub">
        <button type="button" className="bk-hub-btn" onClick={showCode}>
          <span className="bk-hub-icon" style={{ background: "var(--selected)", color: "var(--grape-deep)" }}>📱</span>
          <span>สแกน QR หน้าร้าน</span>
        </button>
        <button type="button" className="bk-hub-btn" onClick={() => historyRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <span className="bk-hub-icon" style={{ background: "var(--bg)", color: "var(--ink)" }}>📜</span>
          <span>ประวัติคะแนน</span>
        </button>
        <button type="button" className="bk-hub-btn" onClick={() => perksRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <span className="bk-hub-icon" style={{ background: "#FFF6DD", color: "#8F6200" }}>⭐</span>
          <span>สิทธิพิเศษ</span>
        </button>
        <button type="button" className="bk-hub-btn" onClick={() => rewardsRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <span className="bk-hub-icon" style={{ background: "var(--mint-tint)", color: "var(--mint-deep)" }}>🎁</span>
          <span>แลกของรางวัล</span>
        </button>
      </div>

      {/* Salon Stamp Card Mission (Screen 13) */}
      <section className="bk-stamp-card">
        <div className="bk-stamp-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24 }}>✂️</span>
            <div>
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, color: "var(--ink)" }}>สมุดสะสมแสตมป์ทำผม</h3>
              <p className="bk-muted" style={{ margin: 0 }}>ครบ 10 ครั้ง รับฟรี ทรีตเมนต์พรีเมียม (฿1,200)</p>
            </div>
          </div>
          <span className="bk-time-badge bk-time-free">{currentStamps} / 10 ดวง</span>
        </div>

        {/* 10 Stamp Slots Grid */}
        <div className="bk-stamp-grid">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((slot) => {
            const isChecked = slot <= currentStamps;
            const isGrand = slot === 10;
            const isMilestone = slot === 5;
            return (
              <div
                key={slot}
                className="bk-stamp-slot"
                data-checked={isChecked || undefined}
                data-grand={isGrand || undefined}
              >
                {isChecked ? (
                  <>
                    <span style={{ fontSize: 18 }}>✓</span>
                    <span>{slot} ครั้ง</span>
                    <span className="bk-stamp-dot" />
                  </>
                ) : isGrand ? (
                  <>
                    <span style={{ fontSize: 18 }}>🏆</span>
                    <span>ฟรี ฿1.2k</span>
                  </>
                ) : isMilestone ? (
                  <>
                    <span style={{ fontSize: 18 }}>🎁</span>
                    <span>5 สระไดร์</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 16 }}>🔒</span>
                    <span>{slot} ครั้ง</span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="bk-policy-box">
          <span className="bk-policy-icon">ℹ️</span>
          <p>
            สะสมเพิ่มอีก {Math.max(10 - currentStamps, 0)} ครั้ง เพื่อรับรางวัลทรีตเมนต์พรีเมียมฟรี
          </p>
        </div>
      </section>

      {/* Rewards Catalog */}
      <section ref={rewardsRef} className="bk-card">
        <div className="bk-row">
          <div>
            <h2 style={{ margin: 0 }}>แลกรับของรางวัล</h2>
            <p className="bk-muted" style={{ margin: 0 }}>ใช้คะแนนแลกสิทธิ์หรือบริการฟรี (มี {points.balance} แต้ม)</p>
          </div>
        </div>

        {/* Category Filter Chips */}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          <button type="button" className="bk-chip" data-active={cat === "all"} onClick={() => setCat("all")}>
            <span>ทั้งหมด</span>
          </button>
          <button type="button" className="bk-chip" data-active={cat === "discount"} onClick={() => setCat("discount")}>
            <span>ส่วนลดเงินสด</span>
          </button>
          <button type="button" className="bk-chip" data-active={cat === "service"} onClick={() => setCat("service")}>
            <span>บริการฟรี</span>
          </button>
        </div>

        <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
          {shownRewards.length === 0 ? (
            <p className="bk-empty">ยังไม่มีของรางวัลในหมวดนี้</p>
          ) : (
            shownRewards.map((r) => (
              <div key={r.name} className="bk-reward-item">
                <div className="bk-reward-info">
                  <div className="bk-reward-icon">
                    {r.kind === "free_offering" ? "💇" : "💰"}
                  </div>
                  <div className="bk-reward-text">
                    <strong>{r.name}</strong>
                    <small>
                      {r.kind === "free_offering" ? `ฟรี ${r.offeringName ?? "บริการ"}` : `ลด ${Number(r.discountBaht).toLocaleString("th-TH")} บาท`}
                    </small>
                    <span className="bk-reward-cost">🪙 {r.pointsCost.toLocaleString("th-TH")} คะแนน</span>
                  </div>
                </div>
                <span className="bk-status" data-status={r.usable ? "confirmed" : "held"}>
                  {r.usable ? "แลกได้" : r.tierName ? `เฉพาะ ${r.tierName}` : "คะแนนไม่พอ"}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Tier Perks & Benefits */}
      {points.tier && (points.tier.benefits?.length > 0 || points.tier.earnMultiplier > 1) && (
        <section ref={perksRef} className="bk-card bk-tier-perks">
          <h2>สิทธิประโยชน์ระดับ {points.tier.name}</h2>
          <ul>
            {points.tier.earnMultiplier > 1 && <li>ได้คะแนน ×{points.tier.earnMultiplier} ทุกบิลบริการ</li>}
            {points.tier.benefits.map((b) => <li key={b}>{b}</li>)}
          </ul>
          <p className="bk-muted">
            ระดับนับจากยอดที่จ่ายใน {points.tier.qualifyMonths} เดือนล่าสุด: {Math.round(points.tier.spend).toLocaleString("th-TH")} บาท · {points.tier.visits} ครั้ง · ใช้คะแนนแลกของแล้วระดับไม่ลด
          </p>
        </section>
      )}

      {/* Points History */}
      {points.history?.length > 0 && (
        <details ref={historyRef} className="bk-card bk-points-history">
          <summary>ประวัติคะแนนสะสม</summary>
          <ul className="bk-booking-list">
            {points.history.map((h, i) => (
              <li key={i} className="bk-booking-row">
                <span className="bk-row-text">
                  <strong>{KIND[h.kind] ?? h.kind}</strong>
                  <small>{new Date(h.at).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" })}{h.shop ? ` · ${h.shop}` : ""}</small>
                </span>
                <span className="bk-points-delta" data-plus={h.points > 0 || undefined}>
                  {h.points > 0 ? "+" : ""}{h.points}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Wallet for other brands (Screen 13 multi-brand wallet)
function Wallet({ here, details, others }) {
  const strip = useRef(null);
  const [at, setAt] = useState(0);
  const count = others.length + (here ? 1 : 0);
  const onScroll = () => {
    const el = strip.current;
    if (el) setAt(Math.round(el.scrollLeft / el.clientWidth));
  };
  return (
    <section className="bk-wallet" aria-label="บัตรสมาชิกของฉัน">
      <div className="bk-wallet-strip" ref={strip} onScroll={onScroll}>
        {here && <div className="bk-wallet-slide">{here}</div>}
        {others.map((o) => (
          <div key={o.slug} className="bk-wallet-slide">
            <MemberCardFace
              programName={o.card.name}
              shopName={o.shopName}
              tierName={o.card.tier?.name}
              theme={o.card.tier?.cardTheme ?? "classic"}
              balance={o.card.balance}
              rule={o.card.rule}
              multiplier={o.card.tier?.earnMultiplier ?? 1}
              next={o.card.tier?.next ?? null}
              logoUrl={o.card.logoUrl}
            >
              {o.card.expiring > 0 && o.card.expiringAt && (
                <span className="bk-points-expiring">
                  {o.card.expiring} คะแนนจะหมดอายุ {new Date(o.card.expiringAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}
                </span>
              )}
              <a className="bk-points-button" href={`/b/${o.slug}/me`}>เปิดบัตรนี้ (QR · รางวัล)</a>
            </MemberCardFace>
          </div>
        ))}
      </div>
      {count > 1 && (
        <div className="bk-wallet-dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => <span key={i} data-on={i === at || undefined} />)}
        </div>
      )}
      <p className="bk-muted bk-wallet-hint">ปัดซ้าย-ขวาเพื่อดูบัตรของร้านอื่น ({count} ใบ)</p>
      {here && at === 0 && details}
    </section>
  );
}

// ============================================================
// MAIN CLIENT COMPONENT: /b/[slug]/me
// ============================================================
export default function MyBookingsClient({ shop, liffId }) {
  const liff = useLiff(liffId);
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [portalTab, setPortalTab] = useState("bookings"); // "bookings" | "vouchers" | "rewards"
  const [bookingFilter, setBookingFilter] = useState("upcoming"); // "upcoming" | "completed" | "cancelled"

  useEffect(() => {
    if (!liff.ready) return;
    if (!liff.idToken) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/b/${shop.slug}/me`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineIdToken: liff.idToken }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || "โหลดการจองไม่สำเร็จ กรุณาลองใหม่");
        if (!cancelled) setState({ loading: false, data: payload.data, error: null });
      } catch (e) {
        if (!cancelled) setState({ loading: false, data: null, error: e.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [liff.ready, liff.idToken, shop.slug]);

  const { loading, data, error } = state;
  const [next, ...later] = data?.upcoming ?? [];
  const pastCompleted = (data?.past ?? []).filter((b) => b.status === "completed" || b.status === "checked_in");
  const pastCancelled = (data?.past ?? []).filter((b) => b.status === "cancelled" || b.status === "no_show" || b.status === "expired");
  const upcomingCount = data?.upcoming?.length ?? 0;
  const completedCount = pastCompleted.length;
  const cancelledCount = pastCancelled.length;

  const points = data?.points;
  const userName = liff.name || "สมาชิก";
  const userTier = points?.tier?.name || "Member";
  const userPoints = points?.balance ?? 0;

  return (
    <CustomerFrame hero={withMedia(shop) ? <ShopHero shop={shop} compact /> : null}>
      <main className="bk-shell bk-with-tabs" aria-busy={loading}>
        <ShopHeader shop={shop} subtitle={liff.name ? `สวัสดีคุณ${liff.name} · Kiwmee Customer Portal` : "Kiwmee Customer Portal"} />

        {/* User Profile Bar (Screen 7 / Screen 13) */}
        {data && (
          <div className="bk-user-bar">
            <div className="bk-user-info">
              <div className="bk-user-avatar">
                <span>{userName.slice(0, 1)}</span>
                <span className="bk-user-status-dot" aria-hidden="true" />
              </div>
              <div className="bk-user-meta">
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong>คุณ{userName}</strong>
                  <span className="bk-gold-badge">★ {userTier}</span>
                </div>
                <span>สะสม {userPoints.toLocaleString("th-TH")} พอยท์ (แทนส่วนลด ฿{Math.floor(userPoints / 10)})</span>
              </div>
            </div>
            <a className="bk-text-button" href="https://line.me" target="_blank" rel="noreferrer" title="LINE Support" style={{ padding: "6px 10px", fontSize: ".82rem" }}>
              💬 ติดต่อ
            </a>
          </div>
        )}

        {/* 3-Tab Portal Navigation (Screens 7, 9, 13) */}
        <nav className="bk-portal-nav" aria-label="เมนูหลักการจองของฉัน">
          <button
            type="button"
            className="bk-portal-tab"
            data-active={portalTab === "bookings"}
            onClick={() => setPortalTab("bookings")}
          >
            <span>📅 การจอง</span>
            {upcomingCount > 0 && <span className="bk-pill-count">{upcomingCount}</span>}
          </button>
          <button
            type="button"
            className="bk-portal-tab"
            data-active={portalTab === "vouchers"}
            onClick={() => setPortalTab("vouchers")}
          >
            <span>🎟️ คูปอง</span>
            <span className="bk-pill-count" style={{ background: "var(--mint-tint)", color: "var(--mint-deep)" }}>3</span>
          </button>
          <button
            type="button"
            className="bk-portal-tab"
            data-active={portalTab === "rewards"}
            onClick={() => setPortalTab("rewards")}
          >
            <span>👑 บัตรสมาชิก</span>
            {userPoints > 0 && <span className="bk-pill-count">{userPoints}</span>}
          </button>
        </nav>

        {loading && <p className="bk-empty" role="status">กำลังโหลดการจองของคุณ…</p>}
        {error && <p className="bk-error" role="alert">{error}</p>}

        {!loading && !error && !data && (
          <section className="bk-card bk-center-card">
            <h2>ดูการจองของคุณ</h2>
            <p className="bk-muted">เปิดหน้านี้จาก LINE ของร้าน หรือเข้าสู่ระบบด้วย LINE เพื่อดูการจองทั้งหมดของคุณที่ {shop.name}</p>
            {liff.login && <button type="button" className="bk-primary" onClick={liff.login}>เข้าสู่ระบบด้วย LINE</button>}
          </section>
        )}

        {/* ============================================================
            TAB 1: BOOKINGS VIEW (SCREEN 7)
            ============================================================ */}
        {data && portalTab === "bookings" && (
          <div style={{ display: "grid", gap: 14 }}>
            {/* Segmented Filter (Screen 7) */}
            <div className="bk-filter-segmented">
              <button
                type="button"
                className="bk-filter-btn"
                data-active={bookingFilter === "upcoming"}
                onClick={() => setBookingFilter("upcoming")}
              >
                <span>กำลังจะมาถึง</span>
                <span className="bk-pill-count">{upcomingCount}</span>
              </button>
              <button
                type="button"
                className="bk-filter-btn"
                data-active={bookingFilter === "completed"}
                onClick={() => setBookingFilter("completed")}
              >
                <span>เสร็จสิ้นแล้ว</span>
                <span className="bk-pill-count">{completedCount}</span>
              </button>
              <button
                type="button"
                className="bk-filter-btn"
                data-active={bookingFilter === "cancelled"}
                onClick={() => setBookingFilter("cancelled")}
              >
                <span>ยกเลิกแล้ว</span>
                <span className="bk-pill-count">{cancelledCount}</span>
              </button>
            </div>

            {/* UPCOMING SUB-TAB */}
            {bookingFilter === "upcoming" && (
              <>
                {next ? (
                  <NextBooking booking={next} directions={data.shop?.directions} slug={shop.slug} shop={shop} />
                ) : (
                  <section className="bk-card bk-center-card">
                    <h2>ยังไม่มีนัดที่จะถึง</h2>
                    <p className="bk-muted">จองคิวใหม่ได้เลย เลือกวันเวลาที่ว่างของร้าน</p>
                    <a className="bk-primary" href={`/b/${shop.slug}`}>จองคิว</a>
                  </section>
                )}

                {later.length > 0 && (
                  <section className="bk-card">
                    <h2>นัดอื่นที่จะถึง</h2>
                    <ul className="bk-booking-list">
                      {later.map((b, i) => (
                        <BookingRow key={`${b.date}-${b.start}-${i}`} booking={b} shopSlug={shop.slug} />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}

            {/* COMPLETED SUB-TAB */}
            {bookingFilter === "completed" && (
              <section className="bk-card">
                <h2>ประวัติการรับบริการที่เสร็จสิ้น</h2>
                {pastCompleted.length === 0 ? (
                  <p className="bk-empty">ยังไม่มีประวัติการรับบริการที่เสร็จสิ้น</p>
                ) : (
                  <ul className="bk-booking-list" data-past>
                    {pastCompleted.map((b, i) => (
                      <BookingRow key={`${b.date}-${b.start}-${i}`} booking={b} shopSlug={shop.slug} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* CANCELLED SUB-TAB */}
            {bookingFilter === "cancelled" && (
              <section className="bk-card">
                <h2>ประวัติการยกเลิกนัดหมาย</h2>
                {pastCancelled.length === 0 ? (
                  <p className="bk-empty">ไม่มีรายการที่ยกเลิก</p>
                ) : (
                  <ul className="bk-booking-list" data-past>
                    {pastCancelled.map((b, i) => (
                      <BookingRow key={`${b.date}-${b.start}-${i}`} booking={b} shopSlug={shop.slug} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}

        {/* ============================================================
            TAB 2: VOUCHERS VIEW (SCREEN 9)
            ============================================================ */}
        {data && portalTab === "vouchers" && (
          <VouchersView slug={shop.slug} />
        )}

        {/* ============================================================
            TAB 3: MEMBER & REWARDS VIEW (SCREEN 13)
            ============================================================ */}
        {data && portalTab === "rewards" && (
          <>
            {data.points ? (
              <MemberRewardsView points={data.points} slug={shop.slug} idToken={liff.idToken} />
            ) : (
              <section className="bk-card bk-center-card">
                <h2>บัตรสมาชิก Kiwmee</h2>
                <p className="bk-muted">ร้านนี้ยังไม่ได้เปิดระบบสะสมแต้ม หรือกำลังเตรียมสิทธิพิเศษสำหรับคุณ</p>
                <a className="bk-primary" href={`/b/${shop.slug}`}>ดูบริการและจองคิว</a>
              </section>
            )}

            {data.otherCards?.length > 0 && (
              <Wallet
                here={data.points ? <MemberRewardsView points={data.points} slug={shop.slug} idToken={liff.idToken} /> : null}
                details={null}
                others={data.otherCards}
              />
            )}
          </>
        )}
      </main>

      <CustomerTabs slug={shop.slug} active="me" />
    </CustomerFrame>
  );
}
