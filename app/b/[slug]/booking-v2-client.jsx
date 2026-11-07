"use client";

// The v2 booking page (design §5): the customer starts from a date or an offering (as the shop's
// flow allows), every step lists only what can really be booked (the rest greyed out with a
// reason), and tapping an earlier step lets them change it without starting over.
// The server decides what comes next (POST /api/b/{slug}/step); this page only shows it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CustomerFrame from "./customer-frame.jsx";
import { useLiff } from "./use-liff.jsx";
import { CheckinQr } from "./qr.jsx";
import { bookingCode } from "../../../src/v2/scan-codes.js";
import { BookingProgress, BookingReview, BookingSubmitBar, CustomerTabs, DepositBox, DirectionsButton, DocumentsBox, OfferingDetails, ShopAbout, ShopHeader, ShopHero, OfferingThumbnail, ResourceChoice, groupTimes, withMedia } from "./booking-presentation.jsx";

const RESOURCE_WORD = { staff: "ช่าง", court: "สนาม", room: "ห้อง", equipment: "อุปกรณ์" };
const STEP_TITLE = {
  offering: "เลือกบริการ",
  date: "เลือกวัน",
  time: "เลือกเวลา",
  duration: "ใช้เวลานานเท่าไหร่",
  party: "จำนวนคน",
  addons: "ตัวเลือกเพิ่มเติม"
};
const DOCUMENT_LABEL = { id_card: "บัตรประชาชน", driving_license: "ใบขับขี่", passport: "พาสปอร์ต" };
// a rental by the day (design 11.7) asks the same steps in its own words
const RENTAL_TITLE = { date: "เลือกวันรับ", duration: "เช่ากี่วัน", time: "เลือกเวลารับ" };
const RENTAL_LABEL = { date: "วันรับ", time: "เวลารับ", duration: "เช่า" };
const REASON_TEXT = {
  FULLY_BOOKED: "เต็ม",
  BUSINESS_CLOSED: "ร้านปิด",
  STAFF_OFF: "ไม่อยู่",
  NO_WORKING_WINDOW: "ไม่มีคิว",
  NO_AVAILABLE_SLOTS: "ไม่มีคิว",
  PAST_WORKING_HOURS: "หมดเวลาจอง",
  OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิดจอง",
  NOT_OFFERED: "ไม่มีบริการนี้",
  RESOURCE_BUSY: "หมดในเวลานี้",
  NOT_ENOUGH_TIME: "เวลาไม่พอ",
  ADDON_GROUP_RULE: "เลือกเกินจำนวน",
  RETURN_CLOSED: "วันคืนร้านปิด"
};
// a day's tile is narrow: one short word under the date
const DAY_REASON_TEXT = { ...REASON_TEXT, PAST_WORKING_HOURS: "ปิดแล้ว", OUTSIDE_BOOKING_WINDOW: "ยังไม่เปิด" };
const KEY = {
  offering: "offeringId",
  resource: "resourceId",
  date: "date",
  time: "time",
  duration: "durationMinutes",
  party: "partySize",
  addons: "addons"
};
const SUMMARY_ORDER = ["date", "offering", "resource", "time", "duration", "party", "addons"];
// labels in the summary (short, so the value keeps the room)
const SUMMARY_LABEL = { date: "วัน", offering: "บริการ", time: "เวลา", duration: "ระยะเวลา", party: "จำนวน", addons: "เพิ่มเติม" };
const ADDON_UNIT = { per_unit: "/ชิ้น", per_hour: "/ชม.", per_day: "/วัน", per_person: "/คน", per_booking: "" };

function formatDate(date, { long = false, shortMonth = false } = {}) {
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long && !shortMonth ? "long" : "short",
    year: "numeric"
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatMinutes(minutes) {
  if (minutes < 60) return `${minutes} นาที`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

// whole days for a rental by the day, else hours and minutes
const formatDuration = (minutes) => (minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440} วัน` : formatMinutes(minutes));
// "พฤ. 5 พ.ย." for the day a rental comes back
const returnDay = (date, minutes) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(minutes / 1440));
  return new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(d);
};

const money = (amount) => `${Number(amount).toLocaleString("th-TH")} บาท`;

function priceText(price) {
  if (!price) return "";
  const per = price.unit === "per_hour" ? "/ชม." : price.unit === "per_person" ? "/คน" : price.unit === "per_day" ? "/วัน" : "";
  return `${price.varies ? "เริ่ม " : ""}${money(price.amount)}${per}`;
}

// What the customer will pay, as far as the page can tell before the server prices the booking.
// A price that changes by day or time ("varies") is only ever shown as a starting price.
// What the chosen add-ons add, as create_booking prices them (booking_plan): per_hour on the whole
// booking's minutes, per_day on its days (a booking within one day = 1)
function addonTotal(addons, selected, minutes) {
  let total = 0;
  for (const [id, quantity] of Object.entries(selected.addons ?? {})) {
    const a = addons.get(id);
    if (!a || !quantity) continue;
    const amount = Number(a.amount);
    if (a.priceUnit === "per_hour") total += (amount * (minutes ?? 0) * quantity) / 60;
    else if (a.priceUnit === "per_day") total += amount * Math.max(Math.ceil((minutes ?? 0) / 1440), 1) * quantity;
    else if (a.priceUnit === "per_person") total += amount * (selected.partySize ?? 1);
    else total += amount * quantity;
  }
  return Math.round(total * 100) / 100;
}

function priceEstimate(offering, selected, addons = new Map()) {
  const base = offeringEstimate(offering, selected);
  if (!base) return null;
  const extraMinutes = Object.entries(selected.addons ?? {}).reduce((sum, [id, q]) => sum + (addons.get(id)?.addsMinutes ?? 0) * q, 0);
  const minutes = (selected.durationMinutes ?? offering.durationMinutes ?? 0) + extraMinutes;
  const more = addonTotal(addons, selected, minutes);
  if (!more) return base;
  if (base.amount === null) return { label: base.label, value: `${base.value} + ${money(more)}`, short: null };
  const total = base.amount + more;
  return base.short ? { label: base.label, value: money(total), short: money(total), amount: total } : { label: base.label, value: `เริ่ม ${money(total)}`, short: null, amount: total };
}

function offeringEstimate(offering, selected) {
  const price = offering?.price;
  if (!price) return null;
  let amount = Number(price.amount);
  const minutes = selected.durationMinutes ?? offering.durationMinutes;
  if (price.unit === "per_hour") {
    if (!minutes) return { label: "ราคา", value: priceText(price), short: null, amount: null };
    amount = (amount * minutes) / 60;
  }
  if (price.unit === "per_person") {
    if (!selected.partySize) return { label: "ราคา", value: priceText(price), short: null, amount: null };
    amount *= selected.partySize;
  }
  if (price.unit === "per_day") {
    if (!minutes) return { label: "ราคา", value: priceText(price), short: null, amount: null };
    amount *= Math.max(Math.ceil(minutes / 1440), 1);
  }
  if (price.varies) return { label: "ราคาเริ่มต้น", value: `เริ่ม ${money(amount)}`, short: null, amount };
  return { label: "ราคา", value: money(amount), short: money(amount), amount };
}

// YYYY-MM-DD for "now" in the shop's own time zone
function todayIn(timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return null;
  }
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
    error.reason = payload?.error?.details?.reason;
    throw error;
  }
  return payload.data;
}


export default function BookingV2Client({ shop, liffId, initialView = null }) {
  const api = `/api/b/${shop.slug}`;
  const [selected, setSelected] = useState(() => initialView?.selected ?? {});
  const [view, setView] = useState(initialView); // { next, ask, options, reason }
  const [pending, setPending] = useState(null); // { step, value } tapped, waiting for the server
  const [details, setDetails] = useState(null); // the offering option whose details are open
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(!initialView);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [points, setPoints] = useState(null); // the LINE member's points and rewards (migration …003200)
  const [rewardId, setRewardId] = useState(null);
  const [booking, setBooking] = useState(null);
  const liff = useLiff(liffId);

  const offerings = useMemo(() => new Map(shop.offerings.map((o) => [o.id, o])), [shop.offerings]);
  const resources = useMemo(() => new Map(shop.resources.map((r) => [r.id, r])), [shop.resources]);
  const addonInfo = useMemo(() => new Map((shop.addonGroups ?? []).flatMap((g) => g.addons.map((a) => [a.id, a]))), [shop.addonGroups]);
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
      if (step === "duration") return formatDuration(value);
      if (step === "party") return `${value} คน`;
      if (step === "addons") {
        // a single add-on id (a cleared one), or the picks { id: quantity }
        if (typeof value === "string") return addonInfo.get(value)?.name ?? "ตัวเลือกเสริม";
        const picked = Object.entries(value ?? {}).filter(([, q]) => q > 0);
        return picked.length ? picked.map(([id, q]) => `${addonInfo.get(id)?.name ?? "ตัวเลือก"}${q > 1 ? ` ×${q}` : ""}`).join(", ") : "ไม่เพิ่ม";
      }
      return String(value);
    },
    [offerings, resources, resourceWord, addonInfo]
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
        setPending(null);
      }
    },
    [api, valueLabel]
  );

  // the server sends the first step with the page; fetch it only if that did not work
  useEffect(() => {
    if (!initialView) run({ selected: {} });
  }, [run, initialView]);

  const next = view?.next;
  const ask = view?.ask;
  const atStart = next?.step === "start" && !ask;
  const atCustomer = next && !ask && !atStart;

  const [category, setCategory] = useState(null);
  const rental = offerings.get(selected.offeringId)?.minDays != null;
  const summaryItems = SUMMARY_ORDER.filter((s) => selected[KEY[s]] !== undefined).map((s) => ({
    step: s,
    label: s === "resource" ? resourceWord : (rental && RENTAL_LABEL[s]) || SUMMARY_LABEL[s] || s,
    value: s === "date"
      ? mediumDate(selected.date)
      : rental && s === "duration" && selected.date
        ? `${formatDuration(selected.durationMinutes)} · คืน ${returnDay(selected.date, selected.durationMinutes)}${selected.time ? ` ${selected.time} น.` : ""}`
        : valueLabel(s, selected[KEY[s]]),
    // the day on its own line, the date below it
    display: s === "date" ? <>{dayName(selected.date)}<br />{dateOnly(selected.date)}</> : null
  }));
  const estimate = priceEstimate(offerings.get(selected.offeringId), selected, addonInfo);
  // a reward chosen with points: the price the customer will pay at the desk
  const chosenReward = points?.rewards.find((r) => r.id === rewardId) ?? null;
  // a free service is worth the service's own price (not its extras), up to the reward's cap
  const offeringPrice = offeringEstimate(offerings.get(selected.offeringId), selected)?.amount ?? null;
  const rewardOff = (r) => (r.kind === "free_offering" ? Math.min(offeringPrice ?? 0, r.discountBaht ?? Infinity) : r.discountBaht);
  const shownPrice = chosenReward && estimate?.amount != null
    ? { ...estimate, label: "ราคาหลังใช้คะแนน", value: money(Math.max(estimate.amount - rewardOff(chosenReward), 0)), short: estimate.short ? money(Math.max(estimate.amount - rewardOff(chosenReward), 0)) : null }
    : estimate;

  const depositAmount = useMemo(() => {
    if (!shop.deposit || shop.deposit.mode === "none") return null;
    const est = estimate?.amount;
    if (shop.deposit.mode === "full") return est ?? null;
    if (shop.deposit.mode === "percent") return est ? Math.round((est * shop.deposit.value) / 100) : null;
    return typeof shop.deposit.value === "number" ? (est ? Math.min(shop.deposit.value, est) : shop.deposit.value) : null;
  }, [shop.deposit, estimate]);

  // the tapped choice lights up at once; the server's answer follows
  const choose = (step, value) => {
    setPending({ step, value });
    return run({ selected: { ...selected, [KEY[step]]: value }, changed: step });
  };
  const showStep = (step) => {
    setPending({ step: "show", value: step });
    return run({ selected, ask: step });
  };

  // Pre-select offering if passed in URL (?offeringId=... or ?serviceId=...)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const targetOffering = params.get("offeringId") || params.get("serviceId");
    if (targetOffering && !selected.offeringId && offerings.has(targetOffering)) {
      choose("offering", targetOffering);
    }
  }, [offerings]);

  // Default to offering selection if landing at start without selection
  useEffect(() => {
    if (atStart && !selected.offeringId && !selected.date) {
      showStep("offering");
    }
  }, [atStart]);

  // a LINE member at the last step (the customer's details): their points and rewards, once
  const reachedCustomer = Boolean(view?.next && !view?.ask && view.next.step !== "start");
  useEffect(() => {
    if (!reachedCustomer || !liff.idToken || points?.offeringId === selected.offeringId) return;
    const offeringId = selected.offeringId;
    post(`${api}/me/rewards`, { lineIdToken: liff.idToken, offeringId }).then(
      (p) => setPoints(p ? { ...p, offeringId } : { rewards: [], none: true, offeringId }),
      () => setPoints({ rewards: [], none: true, offeringId })
    );
    setRewardId(null);
  }, [reachedCustomer, liff.idToken, api, points?.offeringId, selected.offeringId]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post(`${api}/bookings`, { selected, customer, lineIdToken: liff.idToken || undefined, rewardId: rewardId || undefined });
      setBooking(result);
    } catch (e) {
      if (e.status === 409 && e.reason === "ADDON_UNAVAILABLE") {
        setBusy(false);
        await run({ selected, ask: "addons" });
        setNotice("ตัวเลือกเสริมที่เลือกเพิ่งหมดไป กรุณาเลือกใหม่");
        return;
      }
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
      <CustomerFrame>
        <main className="bk-shell">
          <BookingProgress phase="complete" />
          <BookingDone shop={shop} booking={booking} items={summaryItems} selected={selected} resourceWord={resourceWord}
            onSlip={(view) => setBooking((b) => ({ ...b, status: view.booking.status, deposit: { ...b.deposit, slips: view.booking.deposit?.slips ?? 1 } }))} />
          <PoweredBy />
        </main>
      </CustomerFrame>
    );
  }

  const categories = ask === "offering" ? [...new Set((view?.options ?? []).map((o) => offerings.get(o.value)?.category).filter(Boolean))] : [];
  const shownOptions = (view?.options ?? []).filter((o) => ask !== "offering" || !category || categories.length < 2 || offerings.get(o.value)?.category === category);
  // big photo cards when every service (or every court / stylist, "any" aside) has a photo
  const pictured = shownOptions.filter((o) => o.value !== null);
  const photoCards =
    pictured.length > 0 &&
    ((ask === "offering" && pictured.every((o) => withMedia(offerings.get(o.value)))) ||
      (ask === "resource" && pictured.every((o) => withMedia(resources.get(o.value)))));
  // แผนผังสนาม: when at least two of the courts / tables offered have a spot on the shop's map
  const mapped = ask === "resource" && pictured.filter((o) => resources.get(o.value)?.layout).length >= 2;
  const optionProps = (o) => {
    const tapped = pending?.step === ask && pending.value === o.value;
    const chosen = pending?.step === ask ? tapped : selected[KEY[ask]] === o.value;
    return {
      type: "button",
      className: "bk-option",
      "data-testid": `option-${ask}`,
      "data-value": o.value === null ? "any" : String(o.value),
      "data-selected": chosen,
      "data-pending": tapped || undefined,
      "data-unavailable": !o.available || undefined,
      "aria-pressed": chosen,
      disabled: busy || !o.available,
      onClick: () => choose(ask, o.value)
    };
  };
  const optionButton = (o) => {
    const button = (
      <button key={String(o.value)} {...optionProps(o)}>
        <OptionBody ask={ask} option={o} offering={offerings.get(o.value)} resource={resources.get(o.value)} resourceWord={resourceWord} date={selected.date} shop={shop} />
        {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
      </button>
    );
    // a service with a description or photos: the card stays short, the rest opens in a sheet
    const offering = ask === "offering" ? offerings.get(o.value) : null;
    if (!offering || (!offering.description && !(offering.media?.length > 0))) return button;
    return (
      <div key={String(o.value)} className="bk-option-wrap">
        {button}
        <button type="button" className="bk-details-link" onClick={() => setDetails(o)} aria-label={`รายละเอียด ${offering.name}`} title="รายละเอียด">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6" /><circle cx="12" cy="7.5" r=".6" fill="currentColor" /></svg>
        </button>
      </div>
    );
  };

  return (
    <CustomerFrame
      hero={withMedia(shop) ? <ShopHero shop={shop} compact={Boolean(atCustomer)} /> : null}
      aside={<SummaryAside items={summaryItems} estimate={estimate} shop={shop} onEdit={showStep} busy={busy} />}
    >
      <main className={liffId && !atCustomer ? "bk-shell bk-with-tabs" : "bk-shell"} aria-busy={busy}>
        <ShopHeader shop={shop} subtitle="จองคิวออนไลน์ · เลือกจากคิวว่างของร้าน" />
        {/* the venue's details while the customer is still looking; out of the way once they start picking */}
        {!atCustomer && summaryItems.length === 0 && <ShopAbout shop={shop} />}
        <BookingProgress phase={atCustomer ? "customer" : "selection"} ask={ask} />

        {!atCustomer && summaryItems.length > 0 && (
          <nav className="bk-chips" aria-label="ที่เลือกไว้">
            {summaryItems.map((item) => (
              <button key={item.step} type="button" className="bk-chip" data-active={ask === item.step} data-pending={(pending?.step === "show" && pending.value === item.step) || undefined} onClick={() => showStep(item.step)} disabled={busy}>
                <span>{item.step === "date" ? shortDate(selected.date) : item.value}</span>
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
                <button key={c} type="button" className="bk-start-button" data-pending={(pending?.step === "show" && pending.value === c) || undefined} onClick={() => showStep(c)} disabled={busy}>
                  <span className="bk-start-icon" aria-hidden="true">{c === "date" ? "▦" : c === "offering" ? "✂" : "☺"}</span>
                  <span className="bk-start-text">
                    <strong>{c === "date" ? "เลือกวันก่อน" : c === "offering" ? "เลือกบริการก่อน" : `เลือก${resourceWord}ก่อน`}</strong>
                    <span>
                      {c === "date" ? "ดูว่าวันไหนว่าง แล้วเลือกบริการ" : c === "offering" ? "เลือกบริการ แล้วดูวันเวลาที่ว่าง" : `เลือก${resourceWord}ที่ต้องการ`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {ask && view.options && (
          <section className="bk-card" data-step={ask}>
            {ask === "offering" && (
              <>
                <div className="bk-storefront-banner">
                  <div className="bk-storefront-icon">🏪</div>
                  <div className="bk-storefront-details">
                    <div className="bk-storefront-row">
                      <strong>{shop.name}</strong>
                      <span className="bk-badge-live">● เปิดให้บริการ</span>
                    </div>
                    <small className="bk-muted">{shop.address || "พร้อมดูแลและให้บริการลูกค้าทุกท่าน"}</small>
                  </div>
                </div>
                <div className="bk-tip-notice">
                  <span>💡</span>
                  <span><strong>เลือกบริการที่ต้องการ:</strong> ดูแลอย่างพิถีพิถันโดยช่างผู้เชี่ยวชาญ พร้อมคิวว่างแบบเรียลไทม์</span>
                </div>
              </>
            )}
            <div className="bk-step-head">
              <h2>{ask === "resource" ? `เลือก${resourceWord}` : (rental && RENTAL_TITLE[ask]) || STEP_TITLE[ask]}</h2>
              {ask === "time" && selected.date && (
                <p className="bk-muted">
                  {formatDate(selected.date, { long: true })} · {rental ? "คืนเวลาเดียวกัน" : "เวลาตามร้าน"}
                  {rental && selected.durationMinutes ? ` วัน${returnDay(selected.date, selected.durationMinutes)}` : ""}
                </p>
              )}
              {ask === "duration" && rental && <p className="bk-muted">เช่าเป็นรอบ 24 ชม. คืนเวลาเดียวกับที่รับ</p>}
            </div>
            {ask !== "addons" && (view.options.length === 0 || !view.options.some((o) => o.available)) ? (
              <p className="bk-empty">{ask === "time" ? "วันนี้ไม่มีเวลาว่างแล้ว" : "ไม่มีตัวเลือกที่ว่าง"} {view.reason ? `(${REASON_TEXT[view.reason] ?? view.reason})` : ""} — ลองเปลี่ยนตัวเลือกด้านบน</p>
            ) : null}
            {categories.length > 1 && (
              <div className="bk-filter" role="group" aria-label="หมวดบริการ">
                {[null, ...categories].map((c) => (
                  <button key={c ?? "all"} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>
                    {c ?? "ทั้งหมด"}
                  </button>
                ))}
              </div>
            )}
            {ask === "addons" ? (
              <AddonsStep key={`${selected.date}-${selected.time}`} view={view} info={addonInfo} initial={selected.addons} busy={busy} onDone={(picks) => choose("addons", picks)} />
            ) : ask === "date" ? (
              <DateStrip options={view.options} today={todayIn(shop.timezone)} optionProps={optionProps} />
            ) : ask === "time" ? (
              <TimeTabs key={selected.date} options={view.options} chosen={selected.time} optionButton={optionButton} />
            ) : ask === "resource" && mapped ? (
              <VenueMap options={shownOptions} resources={resources} resourceWord={resourceWord} optionProps={optionProps} list={
                <div className={`bk-options bk-options-${ask}`} data-photos={photoCards || undefined}>
                  {shownOptions.map(optionButton)}
                </div>
              } />
            ) : (
              <div className={`bk-options bk-options-${ask}`} data-photos={photoCards || undefined}>
                {shownOptions.map(optionButton)}
              </div>
            )}
            {ask === "offering" && (
              <div className="bk-guarantee-banner">
                <span>🛡️</span>
                <div>
                  <strong>รับประกันความพึงพอใจ 7 วัน</strong>
                  <p>ดูแลอย่างใส่ใจ ปรับแก้ทรงฟรีไม่มีค่าใช้จ่ายหากไม่ตรงใจ</p>
                </div>
              </div>
            )}
          </section>
        )}

        {atCustomer && (
          <>
            <BookingReview items={summaryItems} onEdit={showStep} busy={busy} price={shownPrice} />
            {points && !points.none && points.rewards.length > 0 && (
              <PointsChoice points={points} chosen={rewardId} onChoose={setRewardId} busy={busy} valueOf={rewardOff} />
            )}
            <form id="booking-customer" className="bk-card" onSubmit={submit}>
              <h2>ข้อมูลผู้จอง</h2>
              {liff.idToken && customer.name && (
                <div className="bk-line-badge" role="status">
                  <span className="bk-line-dot" aria-hidden="true" />
                  <span>เชื่อมต่อ LINE แล้ว · ดึงข้อมูลอัตโนมัติ</span>
                </div>
              )}
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
              {shop.deposit && <DepositNote deposit={shop.deposit} estimate={estimate} />}
              <div className="bk-policy-box">
                <span className="bk-policy-icon" aria-hidden="true">ℹ️</span>
                <p>
                  <SelfServiceNote shop={shop} /> ร้านใช้ชื่อและเบอร์นี้เพื่อติดต่อเรื่องนัดหมายนี้เท่านั้น
                </p>
              </div>
              <p className="bk-fine">
                การกดยืนยันถือว่ายอมรับ{" "}
                <a href="/terms" target="_blank" rel="noreferrer">ข้อตกลงการใช้บริการ</a>
                {" และ "}
                <a href="/privacy" target="_blank" rel="noreferrer">นโยบายความเป็นส่วนตัว</a>
              </p>
            </form>
          </>
        )}
        {atCustomer && (
          <BookingSubmitBar
            formId="booking-customer"
            disabled={busy || !liff.ready}
            busy={busy}
            price={shownPrice?.short}
            deposit={depositAmount}
          />
        )}
        <PoweredBy />
      </main>
      {liffId && !atCustomer && <CustomerTabs slug={shop.slug} active="book" />}
      {details && offerings.get(details.value) && (
        <OfferingDetails
          offering={offerings.get(details.value)}
          length={offeringLength(offerings.get(details.value))}
          price={offerings.get(details.value).price ? priceText(offerings.get(details.value).price) : null}
          available={details.available}
          reason={details.available ? null : REASON_TEXT[details.reason] ?? "ไม่ว่าง"}
          busy={busy}
          onClose={() => setDetails(null)}
          onChoose={() => {
            setDetails(null);
            choose("offering", details.value);
          }}
        />
      )}
    </CustomerFrame>
  );
}

const offeringLength = (offering) => {
  if (!offering) return "ตามความเหมาะสม";
  if (offering.minDays != null) {
    return offering.minDays === offering.maxDays ? `${offering.minDays} วัน` : `${offering.minDays}–${offering.maxDays} วัน`;
  }
  if (offering.durationMinutes) {
    return formatMinutes(offering.durationMinutes);
  }
  if (offering.minMinutes && offering.maxMinutes) {
    return `${formatMinutes(offering.minMinutes)}–${formatMinutes(offering.maxMinutes)}`;
  }
  return "เลือกระยะเวลาเอง";
};

// The extras for the chosen offering at the chosen time, grouped as the shop set them up. The engine
// says which can still be taken (and how many); the customer picks, then goes on.
function addonRule(g) {
  if (g.maxSelect === 1) return g.minSelect >= 1 ? "ต้องเลือก 1 อย่าง" : "เลือกได้ 1 อย่าง";
  if (g.minSelect > 0) return `ต้องเลือกอย่างน้อย ${g.minSelect} อย่าง`;
  if (g.maxSelect) return `เลือกได้ไม่เกิน ${g.maxSelect} อย่าง`;
  return "เลือกได้หลายอย่าง";
}

function addonPrice(a) {
  if (!a) return "";
  const amount = Number(a.amount);
  const parts = [amount ? `+${money(amount)}${ADDON_UNIT[a.priceUnit] ?? ""}` : "ไม่มีค่าใช้จ่าย"];
  if (a.addsMinutes) parts.push(`+${formatMinutes(a.addsMinutes)}`);
  return parts.join(" · ");
}

function AddonsStep({ view, info, initial, busy, onDone }) {
  const [picks, setPicks] = useState(() => Object.fromEntries(Object.entries(initial ?? {}).filter(([, q]) => q > 0)));
  const groups = view.groups ?? [];
  const inGroup = (id) => view.options.filter((o) => o.groupId === id);
  const count = (id, from = picks) => inGroup(id).filter((o) => from[o.value] > 0).length;
  const unmet = groups.filter((g) => count(g.id) < g.minSelect);

  function toggle(g, o) {
    setPicks((p) => {
      const next = { ...p };
      if (next[o.value] > 0) {
        delete next[o.value];
        return next;
      }
      if (g.maxSelect === 1) for (const x of inGroup(g.id)) delete next[x.value];
      else if (g.maxSelect && count(g.id, p) >= g.maxSelect) return p;
      next[o.value] = 1;
      return next;
    });
  }

  const setQuantity = (o, quantity) =>
    setPicks((p) => {
      const next = { ...p };
      if (quantity <= 0) delete next[o.value];
      else next[o.value] = Math.min(quantity, o.maxQuantity);
      return next;
    });

  const chosen = Object.keys(picks).length;
  return (
    <div className="bk-addons">
      {groups.map((g) => (
        <fieldset key={g.id} className="bk-addon-group">
          <legend>
            {g.name} <small>{addonRule(g)}</small>
          </legend>
          {inGroup(g.id).map((o) => {
            const a = info.get(o.value);
            const on = picks[o.value] > 0;
            const single = g.maxSelect === 1;
            return (
              <div key={o.value} className="bk-addon" data-selected={on} data-off={!o.available}>
                <button
                  type="button"
                  role={single ? "radio" : "checkbox"}
                  aria-checked={on}
                  className="bk-addon-pick"
                  data-testid="option-addons"
                  data-value={o.value}
                  disabled={busy || (!o.available && !on)}
                  onClick={() => toggle(g, o)}
                >
                  <span className={single ? "bk-choice-mark bk-choice-round" : "bk-choice-mark"} aria-hidden="true" />
                  <span className="bk-option-text">
                    <strong>{o.label}</strong>
                    {a?.description && <span className="bk-option-desc">{a.description}</span>}
                    <span className="bk-muted">{addonPrice(a)}</span>
                  </span>
                  {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                </button>
                {on && o.maxQuantity > 1 && (
                  <span className="bk-stepper" role="group" aria-label={`จำนวน${o.label}`}>
                    <button type="button" aria-label="ลดจำนวน" disabled={busy} onClick={() => setQuantity(o, picks[o.value] - 1)}>−</button>
                    <output aria-live="polite">{picks[o.value]}</output>
                    <button type="button" aria-label="เพิ่มจำนวน" disabled={busy || picks[o.value] >= o.maxQuantity} onClick={() => setQuantity(o, picks[o.value] + 1)}>+</button>
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      {unmet.length > 0 && <p className="bk-muted">ยังต้องเลือก: {unmet.map((g) => `${g.name} (${addonRule(g)})`).join(" · ")}</p>}
      <button type="button" className="bk-primary" disabled={busy || unmet.length > 0} onClick={() => onDone(picks)}>
        {chosen ? `ต่อไป · เพิ่ม ${chosen} อย่าง` : "ไม่เพิ่ม ไปต่อ"}
      </button>
    </div>
  );
}

// All dates the server offers in one swipeable row, a week's worth on screen at a time.
// Times as tabs (เช้า / บ่าย / เย็น), the way an app shows slots: one part of the day at a time,
// starting with the part that holds the chosen time, or the first with a free one.
const PART_ICON = { morning: "☀️", afternoon: "⛅", evening: "🌙" };
function TimeTabs({ options, chosen, optionButton }) {
  const parts = groupTimes(options);
  const start = parts.find((p) => p.options.some((o) => o.value === chosen)) ?? parts.find((p) => p.options.some((o) => o.available)) ?? parts[0];
  const [open, setOpen] = useState(start?.key);
  const part = parts.find((p) => p.key === open) ?? parts[0];
  if (!part) return null;
  return (
    <div className="bk-time-groups">
      {parts.length > 1 && (
        <div className="bk-time-tabs" role="tablist" aria-label="ช่วงเวลา">
          {parts.map((p) => {
            const free = p.options.filter((o) => o.available).length;
            return (
              <button key={p.key} type="button" role="tab" aria-selected={p.key === part.key} data-empty={free === 0 || undefined} onClick={() => setOpen(p.key)}>
                <span aria-hidden="true">{PART_ICON[p.key]}</span>
                {p.label.replace("ช่วง", "")}
                <small>{free > 0 ? `ว่าง ${free}` : "เต็ม"}</small>
              </button>
            );
          })}
        </div>
      )}
      <div className="bk-options bk-options-time" role="tabpanel" aria-label={part.label}>{part.options.map(optionButton)}</div>
    </div>
  );
}

// "ใช้คะแนน" (migration …003200): a LINE member picks one reward; its points are set aside with the
// booking and the discount comes off at the desk. Rewards they cannot use yet say why.
function PointsChoice({ points, chosen, onChoose, busy, valueOf }) {
  return (
    <section className="bk-card bk-points-choice" aria-labelledby="points-choice-title">
      <div className="bk-row">
        <h2 id="points-choice-title">ใช้คะแนนสะสม</h2>
        <span className="bk-muted">มี {points.balance.toLocaleString("th-TH")} คะแนน{points.tier ? ` · ${points.tier.name}` : ""}</span>
      </div>
      <div className="bk-options bk-options-reward" role="radiogroup" aria-label="เลือกรางวัล">
        <button type="button" className="bk-option" role="radio" aria-checked={!chosen} data-selected={!chosen} disabled={busy} onClick={() => onChoose(null)}>
          <span className="bk-option-text"><strong>ไม่ใช้คะแนน</strong></span>
          <span className="bk-choice-mark" aria-hidden="true" />
        </button>
        {points.rewards.map((r) => (
          <button key={r.id} type="button" className="bk-option" role="radio" aria-checked={chosen === r.id} data-selected={chosen === r.id}
            data-unavailable={!r.usable || undefined} disabled={busy || !r.usable} onClick={() => onChoose(r.id)}>
            <span className="bk-option-text">
              <strong>{r.name}</strong>
              <span className="bk-option-meta">
                <span>ใช้ {r.pointsCost.toLocaleString("th-TH")} คะแนน</span>
                <b className="bk-option-price">{r.kind === "free_offering" ? `ฟรี ${r.offeringName ?? "บริการ"}${r.fits !== false && valueOf(r) > 0 ? ` (${money(valueOf(r))})` : ""}` : `ลด ${money(r.discountBaht)}`}</b>
              </span>
            </span>
            {!r.usable && <small className="bk-reason">{r.fits === false ? `ใช้กับ ${r.offeringName} เท่านั้น` : r.tierName ? `เฉพาะ ${r.tierName} ขึ้นไป` : "คะแนนไม่พอ"}</small>}
            <span className="bk-choice-mark" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="bk-fine">คะแนนถูกกันไว้กับการจองนี้ทันที ส่วนลดหักตอนจ่ายที่ร้าน · ยกเลิกหรือไม่ได้มา คะแนนคืนให้อัตโนมัติ</p>
    </section>
  );
}

// แผนผังสนาม (migration …002900): the courts / tables / rooms where they really are, as the shop drew
// them on a grid. The same choices as the list: a full one is grey and cannot be tapped. "Any" and
// anything not on the map stay as buttons under it. The customer can switch to the list.
function VenueMap({ options, resources, resourceWord, optionProps, list }) {
  const [asList, setAsList] = useState(false);
  const placed = options.filter((o) => o.value !== null && resources.get(o.value)?.layout);
  const rest = options.filter((o) => !placed.includes(o));
  const rows = Math.max(...placed.map((o) => { const s = resources.get(o.value).layout; return s.row + s.h - 1; }));
  const cols = Math.max(...placed.map((o) => { const s = resources.get(o.value).layout; return s.col + s.w - 1; }));
  const free = placed.filter((o) => o.available).length;
  return (
    <div className="bk-venue">
      <div className="bk-dates-head">
        <span className="bk-muted">{free > 0 ? `ว่าง ${free} จาก ${placed.length}` : "ไม่มีที่ว่างในผัง"}</span>
        <button type="button" className="bk-cal-toggle" aria-pressed={asList} onClick={() => setAsList(!asList)}>
          {asList ? "ดูผัง" : "ดูเป็นรายการ"}
        </button>
      </div>
      {asList ? list : (
        <>
          <div className="bk-venue-map" role="group" aria-label={`ผัง${resourceWord}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(64px, auto))` }}>
            {placed.map((o) => {
              const r = resources.get(o.value);
              const s = r.layout;
              const props = optionProps(o);
              return (
                <button key={o.value} {...props} data-testid="option-resource-map" className="bk-venue-spot"
                  style={{ gridRow: `${s.row} / span ${s.h}`, gridColumn: `${s.col} / span ${s.w}` }}
                  aria-label={`${r.name}${o.available ? "" : ` · ${REASON_TEXT[o.reason] ?? "ไม่ว่าง"}`}`}>
                  <span className="bk-venue-lines" aria-hidden="true" />
                  <strong>{r.name}</strong>
                  <small>{o.available ? (props["data-selected"] ? "เลือกแล้ว" : "ว่าง") : REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>
                </button>
              );
            })}
          </div>
          <p className="bk-cal-legend">
            <span><i data-kind="free" /> ว่าง</span>
            <span><i data-kind="full" /> ไม่ว่าง</span>
            <span><i data-kind="picked" /> ที่เลือก</span>
          </p>
          {rest.length > 0 && (
            <div className="bk-options bk-options-resource">
              {rest.map((o) => (
                <button key={String(o.value)} {...optionProps(o)}>
                  <ResourceChoice resource={resources.get(o.value)} label={o.label} resourceWord={resourceWord} any={o.value === null} />
                  {!o.available && <small className="bk-reason">{REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The days the shop takes bookings: a strip to swipe (the next days, the usual case) or a month
// calendar (booking far ahead, a rental). Both show the same days from the engine, so a full or
// closed day looks the same in either and cannot be tapped.
function DateStrip({ options, today, optionProps }) {
  // the customer's last choice, on this phone only
  const [calendar, setCalendarState] = useState(false);
  useEffect(() => {
    try { if (window.localStorage.getItem("kiwmee.dates") === "calendar") setCalendarState(true); } catch { /* private mode */ }
  }, []);
  const setCalendar = (on) => {
    setCalendarState(on);
    try { window.localStorage.setItem("kiwmee.dates", on ? "calendar" : "strip"); } catch { /* private mode */ }
  };
  const strip = useRef(null);
  useEffect(() => {
    if (!calendar) strip.current?.querySelector('[data-selected="true"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [calendar]);
  const month = (value, opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${value}T00:00:00Z`));
  const first = options[0]?.value;
  const last = options[options.length - 1]?.value;
  const range = first ? (month(first, { month: "long" }) === month(last, { month: "long" }) ? month(first, { month: "long", year: "numeric" }) : `${month(first, { month: "short" })} – ${month(last, { month: "short", year: "numeric" })}`) : "";
  const scroll = (direction) => strip.current?.scrollBy({ left: direction * strip.current.clientWidth, behavior: "smooth" });
  const toggle = (
    <button type="button" className="bk-cal-toggle" aria-pressed={calendar} onClick={() => setCalendar(!calendar)}>
      {calendar ? <><StripIcon /> แถบวัน</> : <><CalendarIcon /> ปฏิทิน</>}
    </button>
  );
  if (calendar) return <MonthCalendar options={options} today={today} optionProps={optionProps} toggle={toggle} />;
  return (
    <div className="bk-dates">
      <div className="bk-dates-head">
        <strong>{range}</strong>
        <div>
          {toggle}
          <button type="button" className="bk-icon-button" aria-label="วันก่อนหน้า" onClick={() => scroll(-1)}>‹</button>
          <button type="button" className="bk-icon-button" aria-label="วันถัดไป" onClick={() => scroll(1)}>›</button>
        </div>
      </div>
      <div className="bk-date-strip" ref={strip}>
        {options.map((o) => (
          <button key={o.value} {...optionProps(o)}>
            <DateBody value={o.value} today={today} />
            {!o.available && <small className="bk-reason">{DAY_REASON_TEXT[o.reason] ?? "ไม่ว่าง"}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

const WEEK_HEAD = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const monthKey = (value) => value.slice(0, 7);
const shiftMonth = (key, n) => {
  const d = new Date(`${key}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

/** One month at a time, Sunday first; days outside the booking window are greyed out, not buttons */
function MonthCalendar({ options, today, optionProps, toggle }) {
  const byDay = new Map(options.map((o) => [o.value, o]));
  const firstMonth = options.length ? monthKey(options[0].value) : monthKey(today);
  const lastMonth = options.length ? monthKey(options[options.length - 1].value) : firstMonth;
  const start = options.find((o) => optionProps(o)["data-selected"]) ?? options.find((o) => o.available) ?? options[0];
  const [shown, setShown] = useState(start ? monthKey(start.value) : firstMonth);

  const d = new Date(`${shown}-01T00:00:00Z`);
  const lead = d.getUTCDay();
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${shown}-${String(i + 1).padStart(2, "0")}`)];
  const title = new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "long", year: "numeric" }).format(d);
  const free = options.filter((o) => o.available && monthKey(o.value) === shown).length;

  return (
    <div className="bk-dates bk-calendar">
      <div className="bk-dates-head">
        <strong aria-live="polite">{title}</strong>
        <div>
          {toggle}
          <button type="button" className="bk-icon-button" aria-label="เดือนก่อนหน้า" disabled={shown <= firstMonth} onClick={() => setShown(shiftMonth(shown, -1))}>‹</button>
          <button type="button" className="bk-icon-button" aria-label="เดือนถัดไป" disabled={shown >= lastMonth} onClick={() => setShown(shiftMonth(shown, 1))}>›</button>
        </div>
      </div>
      <div className="bk-cal-grid" role="grid" aria-label={`ปฏิทิน ${title}`}>
        {WEEK_HEAD.map((w) => <span key={w} className="bk-cal-head" role="columnheader">{w}</span>)}
        {cells.map((value, i) => {
          if (!value) return <span key={`blank-${i}`} aria-hidden="true" />;
          const o = byDay.get(value);
          const day = Number(value.slice(8));
          if (!o) return <span key={value} className="bk-cal-day" data-out="true" aria-hidden="true">{day}</span>;
          const props = optionProps(o);
          const reason = o.available ? "ว่าง" : DAY_REASON_TEXT[o.reason] ?? "ไม่ว่าง";
          return (
            <button key={value} {...props} className="bk-cal-day" data-today={value === today || undefined} title={reason}
              aria-label={`${new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${value}T00:00:00Z`))} · ${reason}`}>
              {day}
            </button>
          );
        })}
      </div>
      <p className="bk-cal-legend">
        <span><i data-kind="free" /> ว่าง</span>
        <span><i data-kind="full" /> เต็ม / ปิด</span>
        <span className="bk-muted">{free > 0 ? `เดือนนี้ว่าง ${free} วัน` : "เดือนนี้ไม่มีวันว่าง"}</span>
      </p>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

function StripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="2.5" y="6" width="5" height="12" rx="1.5" /><rect x="9.5" y="6" width="5" height="12" rx="1.5" /><rect x="16.5" y="6" width="5" height="12" rx="1.5" />
    </svg>
  );
}

// "วันอังคาร 3 พ.ย. 2569": the whole date on one line in a summary (the day in full, the month short)
const dayName = (value) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", weekday: "long" }).format(new Date(`${value}T00:00:00Z`));
const dateOnly = (value) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
const mediumDate = (value) => {
  const d = new Date(`${value}T00:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(d);
  return `${part({ weekday: "long" })} ${part({ day: "numeric", month: "short", year: "numeric" })}`;
};
const shortDate = (value) => {
  const d = new Date(`${value}T00:00:00Z`);
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "short" }).format(d)}`;
};

// spelled out here: Node and browsers abbreviate Thai weekdays differently (docs/HANDOFF.md §5)
const SHORT_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function DateBody({ value, today }) {
  const d = new Date(`${value}T00:00:00Z`);
  const part = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(d);
  return (
    <>
      <span className="bk-day-label">{value === today ? "วันนี้" : SHORT_DAYS[d.getUTCDay()]}</span>
      <strong>{part({ day: "numeric" })}</strong>
      <span className="bk-day-month">{part({ month: "short" })}</span>
    </>
  );
}

// Before booking: the shop asks for a deposit by transfer (the exact amount comes with the booking)
function DepositNote({ deposit, estimate }) {
  if (!deposit || deposit.mode === "none") return null;
  const total = estimate?.short ? estimate.amount : null;
  const amount =
    deposit.mode === "full" ? total : deposit.mode === "percent" ? (total !== null ? Math.round((total * deposit.value) / 100) : null) : total !== null ? Math.min(deposit.value, total) : deposit.value;
  if (!amount || amount <= 0) return null;
  const what = money(amount);
  return (
    <p className="bk-notice">
      ร้านนี้ขอมัดจำ <b>{what}</b> โดยโอนเงินผ่าน PromptPay · หลังกดยืนยันจะได้รับ QR Code โอนเงิน แล้วโอนและแนบสลิปภายใน {formatMinutes(deposit.holdMinutes ?? 10)}
    </p>
  );
}

function SelfServiceNote({ shop }) {
  const { cancel, reschedule, cutoffHours } = shop.selfService ?? {};
  const can = cancel && reschedule ? "เลื่อนหรือยกเลิก" : cancel ? "ยกเลิก" : reschedule ? "เลื่อน" : null;
  if (!can) return null;
  const hours = cutoffHours || shop.cancellation_lead_hours || 2;
  return <>{can}ฟรีล่วงหน้า{hours > 0 ? ` ${hours} ชม.` : ""} จากลิงก์ที่ได้รับหลังการจอง · </>;
}

// Wide screens: what has been picked so far, beside the step being answered.
function SummaryAside({ items, estimate, shop, onEdit, busy }) {
  return (
    <div className="bk-aside-card">
      {items.length === 0 ? (
        <>
          <h2>สรุปการจอง</h2>
          <p className="bk-muted">ยังไม่ได้เลือก · ทุกตัวเลือกแสดงตามคิวว่างจริงของร้าน</p>
        </>
      ) : (
        <BookingReview id="booking-aside-title" items={items} onEdit={onEdit} busy={busy} price={estimate} />
      )}
      <p className="bk-fine">
        <SelfServiceNote shop={shop} /> จองกับ {shop.name}
      </p>
    </div>
  );
}

function icsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
}
const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function BookingDone({ shop, booking, items, selected, resourceWord, onSlip }) {
  const timeFormat = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: shop.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const dayPart = (opts) => new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", ...opts }).format(new Date(`${selected.date}T00:00:00Z`));
  const dateOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: shop.timezone }).format(new Date(iso));
  const shortDay = (iso) => new Intl.DateTimeFormat("th-TH", { timeZone: shop.timezone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  // a rental over several days: when to pick up and when to bring it back
  const when = booking.startAt && booking.endAt
    ? dateOf(booking.startAt) !== dateOf(booking.endAt)
      ? `รับ ${timeFormat(booking.startAt)} น. · คืน ${shortDay(booking.endAt)} ${timeFormat(booking.endAt)} น.`
      : `${timeFormat(booking.startAt)}–${timeFormat(booking.endAt)} น.`
    : selected.time ? `${selected.time} น.` : "";
  const assigned = booking.resources?.map((r) => r.name).filter(Boolean).join(", ");
  // what the shop gave: its own kind's word (a car is "รถ", not "ช่าง")
  const givenKind = booking.resources?.[0]?.kind;
  const givenWord = givenKind ? RESOURCE_WORD[givenKind] ?? givenKind : resourceWord;
  const rows = items.filter((item) => item.step !== "date" && item.step !== "time");
  const managePath = booking.manageToken ? `/b/${shop.slug}/manage/${booking.manageToken}` : null;
  const held = booking.status === "held";
  // the ID / licence a rental asks for (design 11.7 E3), sent right here with the customer's consent
  const asked = shop.offerings.find((o) => o.id === selected.offeringId)?.requiredDocuments ?? [];
  const [documents, setDocuments] = useState(() =>
    asked.length ? { required: asked.map((kind) => ({ kind, label: DOCUMENT_LABEL[kind] ?? kind })), uploaded: [], retentionDays: shop.documentRetentionDays ?? 30 } : null
  );

  const [shared, setShared] = useState(false);
  async function shareBooking() {
    const url = managePath ? new URL(managePath, window.location.origin).toString() : window.location.href;
    const text = `นัดหมาย ${shop.name} วันที่ ${formatDate(selected.date, { long: true, shortMonth: true })} เวลา ${when}: ${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `นัดหมาย ${shop.name}`, text, url });
        return;
      } catch {}
    }
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2500);
    } catch {}
  }

  function addToCalendar() {
    const service = rows.find((r) => r.step === "offering")?.value ?? "นัดหมาย";
    const link = managePath ? new URL(managePath, window.location.origin).toString() : window.location.href;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Kiwmee//Booking//TH",
      "BEGIN:VEVENT",
      `UID:${booking.manageToken || booking.id || Date.now()}@kiwmee`,
      `DTSTAMP:${icsTime(new Date().toISOString())}`,
      `DTSTART:${icsTime(booking.startAt)}`,
      `DTEND:${icsTime(booking.endAt)}`,
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

  return (
    <section className="bk-done" data-testid="booking-done">
      <div className="bk-done-head">
        <span className="bk-done-icon" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
        </span>
        <h1>{held ? "กันคิวไว้ให้แล้ว" : booking.status === "pending" ? "ส่งสลิปแล้ว รอร้านยืนยัน" : "จองคิวสำเร็จเรียบร้อยแล้ว!"}</h1>
        <p className="bk-muted">{held && booking.deposit ? "โอนมัดจำเพื่อยืนยันคิว" : "ระบบได้ส่งข้อความยืนยันและรายละเอียดไปที่ LINE เรียบร้อยแล้วค่ะ"}</p>
        <div className="bk-line-pill">
          <span className="bk-line-pill-icon">💬</span>
          <span>แจ้งเตือนเข้า Official Account ทันที</span>
        </div>
      </div>

      {booking.deposit && ["held", "pending"].includes(booking.status) && managePath && (
        <DepositBox
          deposit={booking.deposit}
          status={booking.status}
          deadline={booking.holdExpiresAt ? `${timeFormat(booking.holdExpiresAt)} น.` : null}
          uploadUrl={`/api/b/${shop.slug}/manage/${booking.manageToken}/slip`}
          onUploaded={onSlip}
        />
      )}

      {documents && managePath && (
        <DocumentsBox documents={documents} shopName={shop.name} uploadUrl={`/api/b/${shop.slug}/manage/${booking.manageToken}/document`} onUploaded={(view) => setDocuments(view.documents ?? documents)} />
      )}

      <div className="bk-card bk-done-card bk-pass-card">
        <div className="bk-pass-header">
          <div className="bk-pass-brand">
            <span className="bk-pass-badge">KIWMEE SALON PASS</span>
            {booking.id && <strong className="bk-pass-code">#{bookingCode(booking.id)}</strong>}
          </div>
          <span className="bk-status" data-status={booking.status}>
            {held ? "กันคิวไว้แล้ว" : booking.status === "pending" ? "รอตรวจสลิป" : "รอรับบริการ"}
          </span>
        </div>

        {selected.date && (
          <div className="bk-when">
            <span className="bk-date-tile" aria-hidden="true">
              <small>{dayPart({ month: "short" })}</small>
              <strong>{dayPart({ day: "numeric" })}</strong>
            </span>
            <div>
              <strong>{formatDate(selected.date, { long: true, shortMonth: true })}</strong>
              <span>{when}</span>
            </div>
          </div>
        )}
        <dl className="bk-summary">
          {rows.map((item) => (
            <div key={item.step}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
          {booking.resources?.length > 0 && selected.resourceId == null && (
            <div>
              <dt>{givenWord}</dt>
              <dd>{assigned || "ร้านจัดให้"}</dd>
            </div>
          )}
          {booking.price?.total > 0 && (
            <div>
              <dt>ราคา</dt>
              <dd>
                <strong>{money(booking.price.total)}</strong>
              </dd>
            </div>
          )}
          {booking.points && (
            <div>
              <dt>ใช้คะแนน</dt>
              <dd>{booking.points.name} · {booking.points.points} คะแนน<br /><small className="bk-muted">ลด {money(booking.points.discountBaht)} ตอนจ่ายที่ร้าน</small></dd>
            </div>
          )}
        </dl>
        {booking.id && (
          <div className="bk-done-qr">
            <CheckinQr slug={shop.slug} id={booking.id} open={true} />
            <small className="bk-muted" style={{ textAlign: "center", display: "block", marginTop: 4 }}>แสดง QR Code นี้ให้พนักงานเพื่อเช็คอินเมื่อถึงร้าน</small>
          </div>
        )}
        {held && booking.holdExpiresAt && !booking.deposit && <p className="bk-notice">กรุณาชำระเงินภายใน {timeFormat(booking.holdExpiresAt)} น.</p>}
        <DirectionsButton href={shop.directions} />
      </div>

      <div className="bk-loyalty-callout">
        <div className="bk-loyalty-icon">⭐</div>
        <div className="bk-loyalty-details">
          <div className="bk-loyalty-title">
            <strong>รับแต้มสะสม Kiwmee Points</strong>
            <span className="bk-badge-tier">สมาชิก</span>
          </div>
          <p>แต้มจะเข้ากระเป๋าใน LINE อัตโนมัติหลังรับบริการสำเร็จ เพื่อใช้เป็นส่วนลดครั้งถัดไป</p>
        </div>
      </div>

      <div className="bk-actions-grid">
        {booking.startAt && booking.endAt && (
          <button type="button" className="bk-btn-primary-action bk-btn-calendar" onClick={addToCalendar}>
            <span>📅 เพิ่มลงปฏิทิน</span>
          </button>
        )}
        <button type="button" className="bk-btn-primary-action bk-btn-share" onClick={shareBooking}>
          <span>{shared ? "✓ คัดลอกแล้ว" : "📤 แชร์เข้า LINE"}</span>
        </button>
      </div>

      {managePath && <ManageLink shop={shop} path={managePath} />}

      <a className="bk-home-btn" href={`/b/${shop.slug}`}>
        <span>🏠 กลับสู่หน้าหลัก / ดูบริการอื่นๆ</span>
      </a>

      <div className="bk-trust-lock">
        <span>🔒 การจองปลอดภัยด้วยการเข้ารหัส LINE LIFF Service</span>
      </div>
    </section>
  );
}

// The customer's own link to see, move or cancel this booking later (/b/<slug>/manage/<token>)
function ManageLink({ shop, path }) {
  const [copied, setCopied] = useState(false);
  const { cancel, reschedule, cutoffHours } = shop.selfService ?? {};
  const can = cancel && reschedule ? "เลื่อนหรือยกเลิก" : cancel ? "ยกเลิก" : reschedule ? "เลื่อน" : null;
  const hours = cutoffHours || shop.cancellation_lead_hours || 2;

  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="bk-link-box">
      <strong>{can ? `${can}นัดเองได้` : "ดูการจองนี้ได้ทุกเมื่อ"}</strong>
      <p>
        {can && hours > 0 ? `ฟรีล่วงหน้าถึง ${hours} ชม. ก่อนนัด ` : ""}ผ่านลิงก์ของการจองนี้ · บันทึกเก็บไว้เพื่อจัดการคิวของคุณ
      </p>
      <div className="bk-link-actions">
        <a className="bk-primary" href={path} data-testid="manage-link">
          ดูการจองของฉัน
        </a>
        <button type="button" className="bk-secondary" onClick={copy}>
          {copied ? "✓ คัดลอกแล้ว" : "คัดลอกลิงก์"}
        </button>
      </div>
    </div>
  );
}

// The shop's page, quietly signed by the platform
function PoweredBy() {
  return (
    <a className="bk-powered" href="/" target="_blank" rel="noreferrer">
      จองผ่าน <img src="/brand/kiwmee-logo.svg" alt="kiwmee" />
    </a>
  );
}

function OptionBody({ ask, option, offering, resource, resourceWord, date, shop }) {
  if (ask === "offering" && offering) {
    const length = offeringLength(offering);
    const depVal = shop?.deposit?.mode === "fixed" ? shop.deposit.value : shop?.deposit?.mode === "percent" && offering.price?.amount ? Math.round((offering.price.amount * shop.deposit.value) / 100) : null;
    return (
      <>
        <OfferingThumbnail offering={offering} />
        <span className="bk-option-text">
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, width: "100%" }}>
            <strong>{offering.name}</strong>
            {offering.price && <b className="bk-option-price">{priceText(offering.price)}</b>}
          </span>
          {offering.description && (
            <span className="bk-option-desc">{offering.description}</span>
          )}
          <span className="bk-option-meta">
            <span className="bk-duration-tag">⏱ {length}</span>
            {depVal > 0 && <span className="bk-deposit-tag">🔒 มัดจำ ฿{depVal.toLocaleString("th-TH")}</span>}
          </span>
        </span>
        <span className="bk-choice-mark" aria-hidden="true" />
      </>
    );
  }
  if (ask === "resource") return <ResourceChoice resource={resource} label={option.label} resourceWord={resourceWord} any={option.value === null} />;
  if (ask === "date") return <DateBody value={option.value} />;
  if (ask === "time") return <strong>{option.value}</strong>;
  if (ask === "duration") {
    const days = option.value >= 1440 && option.value % 1440 === 0;
    return (
      <>
        <strong>{formatDuration(option.value)}</strong>
        {days && date && <small className="bk-day-month">คืน {returnDay(date, option.value)}</small>}
      </>
    );
  }
  if (ask === "party") return <strong>{option.value} คน</strong>;
  return <strong>{option?.label || String(option?.value ?? "")}</strong>;
}
