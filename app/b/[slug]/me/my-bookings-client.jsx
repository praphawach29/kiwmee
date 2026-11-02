"use client";

// "การจองของฉัน" (/b/<slug>/me): the next booking as a big card, the others coming up, then the past.
// Who the customer is comes from LINE (src/v2/my-bookings.js checks the ID token on every request).

import { useEffect, useState } from "react";
import CustomerFrame from "../customer-frame.jsx";
import { CustomerTabs, ShopHeader, ShopHero, withMedia } from "../booking-presentation.jsx";
import { useLiff } from "../use-liff.jsx";

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

function NextBooking({ booking }) {
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
          <span>{part(booking.date, { day: "numeric", month: "short", year: "numeric" })} · {booking.start}–{booking.end} น.</span>
        </div>
      </div>
      <dl className="bk-summary">
        <div><dt>บริการ</dt><dd>{booking.offering}</dd></div>
        {resource && <div><dt>{KIND_WORD[resource.kind] ?? "ที่"}</dt><dd>{booking.resources.map((r) => r.name).join(", ")}</dd></div>}
        {booking.total > 0 && <div><dt>ราคา</dt><dd><strong>{money(booking.total)}</strong></dd></div>}
      </dl>
      {booking.link && <a className="bk-primary" href={booking.link}>{booking.status === "held" ? "แนบสลิปโอนมัดจำ" : "ดู เลื่อน หรือยกเลิกนัด"}</a>}
    </article>
  );
}

function BookingRow({ booking }) {
  const body = (
    <>
      <DateTile date={booking.date} small />
      <span className="bk-row-text">
        <strong>{booking.offering}</strong>
        <small>{part(booking.date, { weekday: "short" })} {booking.start}–{booking.end} น.{booking.resources.length ? ` · ${booking.resources.map((r) => r.name).join(", ")}` : ""}</small>
      </span>
      <span className="bk-status" data-status={booking.status}>{STATUS[booking.status] ?? booking.status}</span>
    </>
  );
  return <li>{booking.link ? <a className="bk-booking-row" href={booking.link}>{body}</a> : <div className="bk-booking-row">{body}</div>}</li>;
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

        {data && (
          <>
            {next ? (
              <NextBooking booking={next} />
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
