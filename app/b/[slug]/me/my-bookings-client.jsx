"use client";

// "การจองของฉัน" (/b/<slug>/me): the next booking as a big card, the others coming up, then the past.
// Who the customer is comes from LINE (src/v2/my-bookings.js checks the ID token on every request).

import { useEffect, useRef, useState } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { CustomerTabs, DirectionsButton, ShopHeader, ShopHero, withMedia } from "../booking-presentation.jsx";
import { useLiff } from "../use-liff.jsx";
import { CheckinQr, QrImage } from "../qr.jsx";
import { MemberCardFace } from "../../../member-card.jsx";
import { scanUrl } from "../../../../src/v2/scan-codes.js";

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

const part = (date, opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));
const money = (n) => `${Number(n).toLocaleString("th-TH")} บาท`;

function DateTile({ date, small = false }) {
  return (
    <span className="bk-date-tile" data-small={small || undefined} aria-hidden="true">
      <small>{part(date, { month: "short" })}</small>
      <strong>{part(date, { day: "numeric" })}</strong>
    </span>
  );
}

function NextBooking({ booking, directions, slug }) {
  const resource = booking.resources[0];
  return (
    <article className="bk-next" aria-label="นัดถัดไป">
      <div className="bk-next-head">
        <span className="bk-next-eyebrow">นัดถัดไป</span>
        <span className="bk-status" data-status={booking.status}>{STATUS[booking.status] ?? booking.status}</span>
      </div>
      <div className="bk-when">
        <DateTile date={booking.date} />
        <div>
          <strong>{part(booking.date, { weekday: "long" })}</strong>
          <span>
            {part(booking.date, { day: "numeric", month: "short", year: "numeric" })} ·{" "}
            {booking.endDate && booking.endDate !== booking.date
              ? `รับ ${booking.start} น. · คืน ${part(booking.endDate, { weekday: "short", day: "numeric", month: "short" })} ${booking.end} น.`
              : `${booking.start}–${booking.end} น.`}
          </span>
        </div>
      </div>
      <dl className="bk-summary">
        <div><dt>บริการ</dt><dd>{booking.offering}</dd></div>
        {resource && <div><dt>{KIND_WORD[resource.kind] ?? "ที่"}</dt><dd>{booking.resources.map((r) => r.name).join(", ")}</dd></div>}
        {booking.total > 0 && <div><dt>ราคา</dt><dd><strong>{money(booking.total)}</strong></dd></div>}
        {booking.points && <div><dt>ใช้คะแนน</dt><dd>{booking.points.name} (ลด {money(booking.points.discountBaht)})</dd></div>}
      </dl>
      {booking.link && <a className="bk-primary" href={booking.link}>{booking.status === "held" ? "แนบสลิปโอนมัดจำ" : "ดู เลื่อน หรือยกเลิกนัด"}</a>}
      <CheckinQr slug={slug} id={booking.checkin} />
      <DirectionsButton href={directions} />
    </article>
  );
}

function BookingRow({ booking }) {
  const body = (
    <>
      <DateTile date={booking.date} small />
      <span className="bk-row-text">
        <strong>{booking.offering}</strong>
        <small>{part(booking.date, { weekday: "short" })} {booking.endDate && booking.endDate !== booking.date ? `${booking.start} น. → คืน ${part(booking.endDate, { day: "numeric", month: "short" })}` : `${booking.start}–${booking.end} น.`}{booking.resources.length ? ` · ${booking.resources.map((r) => r.name).join(", ")}` : ""}</small>
      </span>
      <span className="bk-status" data-status={booking.status}>{STATUS[booking.status] ?? booking.status}</span>
    </>
  );
  return <li>{booking.link ? <a className="bk-booking-row" href={booking.link}>{body}</a> : <div className="bk-booking-row">{body}</div>}</li>;
}

const KIND = { earn: "ได้คะแนน", redeem: "ใช้คะแนน", release: "คืนคะแนน", reverse: "หักคืน (คืนเงิน)", adjust: "ร้านปรับคะแนน" };

// The member's points at this brand (migration …002800) and a 6-digit code to show at the counter
// part: "face" (the card with its code), "details" (perks, rewards, history), or both
function PointsCard({ points, slug, idToken, part = null }) {
  const [code, setCode] = useState(null); // { code, until }
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");

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

  const face = part !== "details";
  const details = part !== "face";
  return (
    <section className="bk-points" aria-label={points.name}>
      {face && <MemberCardFace programName={points.name} tierName={points.tier?.name} theme={points.tier?.cardTheme ?? "classic"} balance={points.balance}
        rule={points.rule} multiplier={points.tier?.earnMultiplier ?? 1} next={points.tier?.next ?? null} logoUrl={points.logoUrl}>
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
          <button type="button" className="bk-points-button" onClick={showCode}>แสดง QR สมาชิก (ตอนจ่ายที่ร้าน)</button>
        )}
        {error && <span className="bk-points-error" role="alert">{error}</span>}
      </MemberCardFace>}
      {details && points.tier && (points.tier.benefits.length > 0 || points.tier.earnMultiplier > 1) && (
        <div className="bk-card bk-tier-perks">
          <h2>สิทธิของระดับ {points.tier.name}</h2>
          <ul>
            {points.tier.earnMultiplier > 1 && <li>ได้คะแนน ×{points.tier.earnMultiplier} ทุกบิล</li>}
            {points.tier.benefits.map((b) => <li key={b}>{b}</li>)}
          </ul>
          <p className="bk-muted">ระดับนับจากยอดที่จ่ายใน {points.tier.qualifyMonths} เดือนล่าสุด: {Math.round(points.tier.spend).toLocaleString("th-TH")} บาท · {points.tier.visits} ครั้ง · ใช้คะแนนแลกของแล้วระดับไม่ลด</p>
        </div>
      )}
      {details && points.rewards.length > 0 && (
        <div className="bk-card">
          <h2>แลกคะแนน</h2>
          <p className="bk-muted">บอกพนักงานตอนจ่ายเงิน (1 บิลใช้ได้ 1 รางวัล)</p>
          <ul className="bk-booking-list">
            {points.rewards.map((r) => (
              <li key={r.name} className="bk-booking-row">
                <span className="bk-row-text">
                  <strong>{r.name}</strong>
                  <small>ใช้ {r.pointsCost.toLocaleString("th-TH")} คะแนน · {r.kind === "free_offering" ? `ฟรี ${r.offeringName ?? "บริการ"}` : `ลด ${Number(r.discountBaht).toLocaleString("th-TH")} บาท`}</small>
                </span>
                <span className="bk-status" data-status={r.usable ? "confirmed" : "held"}>{r.usable ? "แลกได้" : r.tierName ? `เฉพาะ ${r.tierName} ขึ้นไป` : "คะแนนไม่พอ"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {details && points.history.length > 0 && (
        <details className="bk-card bk-points-history">
          <summary>ประวัติคะแนน</summary>
          <ul className="bk-booking-list">
            {points.history.map((h, i) => (
              <li key={i} className="bk-booking-row">
                <span className="bk-row-text">
                  <strong>{KIND[h.kind] ?? h.kind}</strong>
                  <small>{new Date(h.at).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" })}{h.shop ? ` · ${h.shop}` : ""}</small>
                </span>
                <span className="bk-points-delta" data-plus={h.points > 0 || undefined}>{h.points > 0 ? "+" : ""}{h.points}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// The member's cards at other brands (migration …003500): swipe sideways, one card at a time, like a
// wallet. This shop's card (with its code and rewards) comes first; the others open their own page.
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
            <MemberCardFace programName={o.card.name} shopName={o.shopName} tierName={o.card.tier?.name} theme={o.card.tier?.cardTheme ?? "classic"}
              balance={o.card.balance} rule={o.card.rule} multiplier={o.card.tier?.earnMultiplier ?? 1} next={o.card.tier?.next ?? null} logoUrl={o.card.logoUrl}>
              {o.card.expiring > 0 && o.card.expiringAt && (
                <span className="bk-points-expiring">{o.card.expiring} คะแนนจะหมดอายุ {new Date(o.card.expiringAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}</span>
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

export default function MyBookingsClient({ shop, liffId }) {
  const liff = useLiff(liffId);
  const [state, setState] = useState({ loading: true, data: null, error: null });

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

  return (
    <CustomerFrame hero={withMedia(shop) ? <ShopHero shop={shop} compact /> : null}>
      <main className="bk-shell bk-with-tabs" aria-busy={loading}>
        <ShopHeader shop={shop} subtitle={liff.name ? `สวัสดีคุณ${liff.name} · การจองของฉัน` : "การจองของฉัน"} />

        {loading && <p className="bk-empty" role="status">กำลังโหลดการจองของคุณ…</p>}
        {error && <p className="bk-error" role="alert">{error}</p>}

        {!loading && !error && !data && (
          <section className="bk-card bk-center-card">
            <h2>ดูการจองของคุณ</h2>
            <p className="bk-muted">เปิดหน้านี้จาก LINE ของร้าน หรือเข้าสู่ระบบด้วย LINE เพื่อดูการจองทั้งหมดของคุณที่ {shop.name}</p>
            {liff.login && <button type="button" className="bk-primary" onClick={liff.login}>เข้าสู่ระบบด้วย LINE</button>}
          </section>
        )}

        {data?.points && !data.otherCards?.length && <PointsCard points={data.points} slug={shop.slug} idToken={liff.idToken} />}
        {data?.otherCards?.length > 0 && (
          <Wallet
            here={data.points ? <PointsCard points={data.points} slug={shop.slug} idToken={liff.idToken} part="face" /> : null}
            details={data.points ? <PointsCard points={data.points} slug={shop.slug} idToken={liff.idToken} part="details" /> : null}
            others={data.otherCards}
          />
        )}

        {data && (
          <>
            {next ? (
              <NextBooking booking={next} directions={data.shop?.directions} slug={shop.slug} />
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
                <ul className="bk-booking-list">{later.map((b, i) => <BookingRow key={`${b.date}-${b.start}-${i}`} booking={b} />)}</ul>
              </section>
            )}
            {data.past.length > 0 && (
              <section className="bk-card">
                <h2>ประวัติการจอง</h2>
                <ul className="bk-booking-list" data-past>{data.past.map((b, i) => <BookingRow key={`${b.date}-${b.start}-${i}`} booking={b} />)}</ul>
              </section>
            )}
          </>
        )}
      </main>
      <CustomerTabs slug={shop.slug} active="me" />
    </CustomerFrame>
  );
}
