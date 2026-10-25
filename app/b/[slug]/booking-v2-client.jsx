"use client";

// The v2 booking page (design §5): the customer starts from a date or an offering (as the shop's
// flow allows), every step lists only what can really be booked (the rest greyed out with a
// reason), and tapping an earlier step lets them change it without starting over.
// The server decides what comes next (POST /api/b/{slug}/step); this page only shows it.

import { useCallback, useEffect, useMemo, useState } from "react";

const RESOURCE_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
const STEP_TITLE = {
  offering: "เลือกบริการ",
  date: "เลือกวัน",
  time: "เลือกเวลา",
  duration: "ใช้เวลานานเท่าไหร่",
  party: "จำนวนคน"
};
const REASON_TEXT = {
  FULLY_BOOKED: "เต็ม",
  BUSINESS_CLOSED: "ร้านปิด",
  STAFF_OFF: "ไม่อยู่",
  NO_WORKING_WINDOW: "ไม่มีคิว",
  NO_AVAILABLE_SLOTS: "ไม่มีคิว",
  PAST_WORKING_HOURS: "หมดเวลาจอง",
  OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิดจอง",
  NOT_OFFERED: "ไม่มีบริการนี้"
};
const KEY = {
  offering: "offeringId",
  resource: "resourceId",
  date: "date",
  time: "time",
  duration: "durationMinutes",
  party: "partySize"
};
const SUMMARY_ORDER = ["date", "offering", "resource", "time", "duration", "party"];

function formatDate(date, { long = false } = {}) {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short"
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} นาที`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

const money = (amount) => `${Number(amount).toLocaleString("th-TH")} บาท`;

function priceText(price) {
  if (!price) return "";
  const per = price.unit === "per_hour" ? "/ชม." : price.unit === "per_person" ? "/คน" : "";
  return `${price.varies ? "เริ่ม " : ""}${money(price.amount)}${per}`;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "ระบบขัดข้อง กรุณาลองใหม่");
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload.data;
}

function useLiff(liffId) {
  const [liff, setLiff] = useState({ ready: !liffId, idToken: null, name: "" });
  useEffect(() => {
    if (!liffId) return;
    let cancelled = false;
    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.onload = async () => {
      try {
        await window.liff.init({ liffId });
        if (!window.liff.isInClient() && !window.liff.isLoggedIn()) {
          if (!cancelled) setLiff({ ready: true, idToken: null, name: "" });
          return;
        }
        if (!window.liff.isLoggedIn()) {
          window.liff.login();
          return;
        }
        const profile = await window.liff.getProfile().catch(() => null);
        if (!cancelled) setLiff({ ready: true, idToken: window.liff.getIDToken(), name: profile?.displayName ?? "" });
      } catch {
        if (!cancelled) setLiff({ ready: true, idToken: null, name: "" });
      }
    };
    script.onerror = () => !cancelled && setLiff({ ready: true, idToken: null, name: "" });
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [liffId]);
  return liff;
}

export default function BookingV2Client({ shop, liffId }) {
  const api = `/api/b/${shop.slug}`;
  const [selected, setSelected] = useState({});
  const [view, setView] = useState(null); // { next, ask, options, reason }
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [booking, setBooking] = useState(null);
  const liff = useLiff(liffId);

  const offerings = useMemo(() => new Map(shop.offerings.map((o) => [o.id, o])), [shop.offerings]);
  const resources = useMemo(() => new Map(shop.resources.map((r) => [r.id, r])), [shop.resources]);
  // a kind the shop named itself ("เก้าอี้นวด") is its own word
  const kind = shop.resources[0]?.kind;
  const resourceWord = RESOURCE_WORD[kind] ?? kind ?? "ช่าง";

  useEffect(() => {
    if (liff.name) setCustomer((c) => (c.name ? c : { ...c, name: liff.name }));
  }, [liff.name]);

  const valueLabel = useCallback(
    (step, value) => {
      if (step === "offering") return offerings.get(value)?.name ?? "บริการ";
      if (step === "resource") return value === null ? `${resourceWord}คนไหนก็ได้` : resources.get(value)?.name ?? resourceWord;
      if (step === "date") return formatDate(value, { long: true });
      if (step === "time") return `${value} น.`;
      if (step === "duration") return formatMinutes(value);
      if (step === "party") return `${value} คน`;
      return String(value);
    },
    [offerings, resources, resourceWord]
  );

  const run = useCallback(
    async (body) => {
      setBusy(true);
      setError(null);
      try {
        const data = await post(`${api}/step`, body);
        setSelected(data.selected);
        setView(data);
        const dropped = data.cleared.filter((c) => c.reason);
        setNotice(
          dropped.length
            ? dropped
                .map((c) => `${valueLabel(c.step, c.value)} ${REASON_TEXT[c.reason] ?? "ใช้ไม่ได้แล้ว"} — กรุณาเลือกใหม่`)
                .join(" · ")
            : null
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [api, valueLabel]
  );

  useEffect(() => {
    run({ selected: {} });
  }, [run]);

  const choose = (step, value) => run({ selected: { ...selected, [KEY[step]]: value }, changed: step });
  const showStep = (step) => run({ selected, ask: step });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post(`${api}/bookings`, { selected, customer, lineIdToken: liff.idToken || undefined });
      setBooking(result);
    } catch (e) {
      if (e.status === 409) {
        setBusy(false);
        await run({ selected: { ...selected, time: undefined }, ask: "time" });
        setNotice("ช่วงเวลานี้เพิ่งถูกจองไป กรุณาเลือกเวลาใหม่");
        return;
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (booking) {
    return (
      <main className="bk-shell">
        <header className="bk-header">
          <h1>{shop.name}</h1>
        </header>
        <section className="bk-card bk-done" data-testid="booking-done">
          <h2>{booking.status === "held" ? "กันคิวไว้ให้แล้ว" : "จองสำเร็จ"}</h2>
          <dl className="bk-summary">
            {SUMMARY_ORDER.filter((s) => selected[KEY[s]] !== undefined).map((s) => (
              <div key={s}>
                <dt>{s === "resource" ? resourceWord : STEP_TITLE[s]?.replace("เลือก", "") ?? s}</dt>
                <dd>{valueLabel(s, selected[KEY[s]])}</dd>
              </div>
            ))}
            {booking.resources.length > 0 && selected.resourceId == null && (
              <div>
                <dt>{resourceWord}</dt>
                <dd>{booking.resources.map((r) => r.name).filter(Boolean).join(", ") || "ร้านจัดให้"}</dd>
              </div>
            )}
            {booking.price?.total > 0 && (
              <div>
                <dt>ราคา</dt>
                <dd>{money(booking.price.total)}</dd>
              </div>
            )}
          </dl>
          {booking.status === "held" && booking.holdExpiresAt && (
            <p className="bk-muted">
              กรุณาชำระเงินภายใน{" "}
              {new Intl.DateTimeFormat("th-TH", { timeZone: shop.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(booking.holdExpiresAt))} น.
            </p>
          )}
        </section>
      </main>
    );
  }

  const next = view?.next;
  const ask = view?.ask;
  const atStart = next?.step === "start" && !ask;
  const atCustomer = next && !ask && !atStart;

  return (
    <main className="bk-shell" aria-busy={busy}>
      <header className="bk-header">
        <h1>{shop.name}</h1>
        <p className="bk-muted">จองคิวออนไลน์</p>
      </header>

      {SUMMARY_ORDER.some((s) => selected[KEY[s]] !== undefined) && (
        <nav className="bk-chips" aria-label="ที่เลือกไว้">
          {SUMMARY_ORDER.filter((s) => selected[KEY[s]] !== undefined).map((s) => (
            <button key={s} type="button" className="bk-chip" data-active={ask === s} onClick={() => showStep(s)} disabled={busy}>
              <span>{valueLabel(s, selected[KEY[s]])}</span>
              <small>เปลี่ยน</small>
            </button>
          ))}
        </nav>
      )}

      {notice && (
        <p className="bk-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="bk-error" role="alert">
          {error}
        </p>
      )}

      {atStart && (
        <section className="bk-card">
          <h2>เริ่มจองจาก</h2>
          <div className="bk-start">
            {next.choices.map((c) => (
              <button key={c} type="button" className="bk-start-button" onClick={() => showStep(c)} disabled={busy}>
                <strong>{c === "date" ? "เลือกวันก่อน" : c === "offering" ? "เลือกบริการก่อน" : `เลือก${resourceWord}ก่อน`}</strong>
                <span>
                  {c === "date" ? "ดูว่าวันไหนว่าง แล้วเลือกบริการ" : c === "offering" ? "เลือกบริการ แล้วดูวันเวลาที่ว่าง" : `เลือก${resourceWord}ที่ต้องการ`}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {ask && view.options && (
        <section className="bk-card" data-step={ask}>
          <h2>{ask === "resource" ? `เลือก${resourceWord}` : STEP_TITLE[ask]}</h2>
          {view.options.length === 0 || !view.options.some((o) => o.available) ? (
            <p className="bk-muted">{ask === "time" ? "วันนี้ไม่มีเวลาว่างแล้ว" : "ไม่มีตัวเลือกที่ว่าง"} {view.reason ? `(${REASON_TEXT[view.reason] ?? view.reason})` : ""} — ลองเปลี่ยนตัวเลือกด้านบน</p>
          ) : null}
          <div className={`bk-options bk-options-${ask}`}>
            {view.options.map((o, i) => {
              const chosen = selected[KEY[ask]] === o.value;
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  className="bk-option"
                  data-testid={`option-${ask}`}
                  data-value={o.value === null ? "any" : String(o.value)}
                  data-selected={chosen}
                  disabled={busy || !o.available}
                  onClick={() => choose(ask, o.value)}
                >
                  <OptionBody ask={ask} option={o} index={i} offering={offerings.get(o.value)} resourceWord={resourceWord} />
                  {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {atCustomer && (
        <form className="bk-card" onSubmit={submit}>
          <h2>ข้อมูลผู้จอง</h2>
          <label className="bk-field">
            <span>ชื่อ</span>
            <input name="name" required maxLength={100} autoComplete="name" value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
          </label>
          <label className="bk-field">
            <span>เบอร์โทร{liff.idToken ? " (ไม่บังคับ)" : ""}</span>
            <input
              name="phone"
              inputMode="tel"
              autoComplete="tel"
              required={!liff.idToken}
              pattern="0[0-9\- ]{8,11}"
              value={customer.phone}
              onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
            />
          </label>
          <button type="submit" className="bk-primary" disabled={busy || !liff.ready}>
            ยืนยันการจอง
          </button>
        </form>
      )}
    </main>
  );
}

function OptionBody({ ask, option, index, offering, resourceWord }) {
  if (ask === "offering" && offering) {
    const length = offering.durationMinutes ? formatMinutes(offering.durationMinutes) : `${formatMinutes(offering.minMinutes)}–${formatMinutes(offering.maxMinutes)}`;
    return (
      <>
        <strong>{offering.name}</strong>
        <span className="bk-muted">
          {length}
          {offering.price ? ` · ${priceText(offering.price)}` : ""}
        </span>
      </>
    );
  }
  if (ask === "resource") return <strong>{option.value === null ? `${resourceWord}คนไหนก็ได้` : option.label}</strong>;
  if (ask === "date") {
    const d = new Date(`${option.value}T00:00:00Z`);
    const part = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(d);
    return (
      <>
        <span className="bk-day-label">{index === 0 ? "วันนี้" : index === 1 ? "พรุ่งนี้" : part({ weekday: "short" })}</span>
        <strong>{part({ day: "numeric", month: "short" })}</strong>
      </>
    );
  }
  if (ask === "time") return <strong>{option.value}</strong>;
  if (ask === "duration") return <strong>{formatMinutes(option.value)}</strong>;
  if (ask === "party") return <strong>{option.value} คน</strong>;
  return <strong>{String(option.value)}</strong>;
}
