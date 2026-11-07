"use client";

// The v2 booking page (design §5): the customer starts from a date or an offering (as the shop's
// flow allows), every step lists only what can really be booked (the rest greyed out with a
// reason), and tapping an earlier step lets them change it without starting over.
// The server decides what comes next (POST /api/b/{slug}/step); this page only shows it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CustomerFrame from "./customer-frame.jsx";
import { useLiff } from "./use-liff.jsx";
import { CheckinQr } from "./qr.jsx";
import { bookingCode } from "../../../src/v2/scan-codes.js";
import { BookingProgress, BookingReview, BookingSubmitBar, CustomerTabs, DepositBox, DocumentsBox, OfferingDetails, ShopAbout, ShopHeader, ShopHero, OfferingThumbnail, ResourceChoice, ResourceThumbnail, groupTimes, withMedia } from "./booking-presentation.jsx";

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
const STEP_KEYS = Object.keys(KEY);
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
  const [dateOptions, setDateOptions] = useState(() => initialView?.ask === "date" ? initialView.options ?? [] : []);
  const [stepTrail, setStepTrail] = useState(() => initialView?.ask ? [initialView.ask] : []);
  const [pending, setPending] = useState(null); // { step, value } tapped, waiting for the server
  const [details, setDetails] = useState(null); // the offering option whose details are open
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(!initialView);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [points, setPoints] = useState(null); // the LINE member's points and rewards (migration …003200)
  const [rewardId, setRewardId] = useState(null);
  // the shop lets the customer transfer the whole price instead of the deposit (migration …003800)
  const [payFull, setPayFull] = useState(false);
  const [booking, setBooking] = useState(null);
  const liff = useLiff(liffId);

  const offerings = useMemo(() => new Map(shop.offerings.map((o) => [o.id, o])), [shop.offerings]);
  const resources = useMemo(() => new Map(shop.resources.map((r) => [r.id, r])), [shop.resources]);
  const addonInfo = useMemo(() => new Map((shop.addonGroups ?? []).flatMap((g) => g.addons.map((a) => [a.id, a]))), [shop.addonGroups]);
  // a kind the shop named itself ("เก้าอี้นวด") is its own word
  const kind = shop.resources[0]?.kind;
  const resourceWord = RESOURCE_WORD[kind] ?? kind ?? "ช่าง";

  // A LINE member: who they are to this shop (name and phone from last time, points, next booking).
  // The form is filled from their last booking; a first-timer gets their LINE name.
  const [welcome, setWelcome] = useState(null);
  useEffect(() => {
    if (!liff.idToken) return;
    let cancelled = false;
    post(`/api/b/${shop.slug}/me/welcome`, { lineIdToken: liff.idToken }).then(
      (w) => {
        if (cancelled) return;
        setWelcome(w);
        setCustomer((c) => ({ ...c, name: c.name || w?.customer?.name || liff.name || "", phone: c.phone || w?.customer?.phone || "" }));
      },
      () => !cancelled && setCustomer((c) => (c.name ? c : { ...c, name: liff.name || "" }))
    );
    return () => {
      cancelled = true;
    };
  }, [liff.idToken, liff.name, shop.slug]);

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

  // only the answer to the latest request counts (a tap while an automatic pick is on its way wins)
  const runSeq = useRef(0);
  const run = useCallback(
    async (body, { keepNotice = false } = {}) => {
      const seq = ++runSeq.current;
      setBusy(true);
      setError(null);
      try {
        const data = await post(`${api}/step`, body);
        if (seq !== runSeq.current) return;
        setSelected(data.selected);
        setView(data);
        if (data.ask === "date") setDateOptions(data.options ?? []);
        setStepTrail((previous) => {
          let trail = previous;
          const current = body.ask ?? body.changed;
          if (current) {
            const index = trail.lastIndexOf(current);
            trail = index >= 0 ? trail.slice(0, index + 1) : [...trail, current];
          }
          if (data.ask) {
            const index = trail.lastIndexOf(data.ask);
            trail = index >= 0 ? trail.slice(0, index + 1) : [...trail, data.ask];
          }
          return trail;
        });
        const dropped = data.cleared.filter((c) => c.reason);
        if (keepNotice && !dropped.length) return;
        setNotice(
          dropped.length
            ? dropped
                .map((c) => `${valueLabel(c.step, c.value)} ${REASON_TEXT[c.reason] ?? "ใช้ไม่ได้แล้ว"} — กรุณาเลือกใหม่`)
                .join(" · ")
            : null
        );
      } catch (e) {
        if (seq === runSeq.current) setError(e.message);
      } finally {
        if (seq === runSeq.current) {
          setBusy(false);
          setPending(null);
        }
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
  const dateLookupSelection = useMemo(() => ({
    offeringId: selected.offeringId,
    resourceId: selected.resourceId,
    durationMinutes: selected.durationMinutes,
    partySize: selected.partySize,
    addons: selected.addons
  }), [selected.offeringId, selected.resourceId, selected.durationMinutes, selected.partySize, selected.addons]);
  useEffect(() => {
    if (ask !== "time") return;
    let current = true;
    post(`${api}/step`, { selected: dateLookupSelection, ask: "date" })
      .then((data) => { if (current) setDateOptions(data.options ?? []); })
      .catch(() => { if (current) setDateOptions([]); });
    return () => { current = false; };
  }, [api, ask, dateLookupSelection]);
  const atStart = next?.step === "start" && !ask;
  const atCustomer = next && !ask && !atStart;

  const [category, setCategory] = useState(null);
  const rental = offerings.get(selected.offeringId)?.minDays != null;
  // วันและเวลาในหน้าเดียว (design "Kiwmee ปรับหน้าตา" · DateTime): once the service is chosen, the
  // stylist, the day and the time are picked on one screen. Not for rentals (days) or a venue drawn
  // on a map (courts keep their own step with the map).
  const venue = shop.resources.filter((r) => r.layout).length >= 2;
  const combined = Boolean(selected.offeringId) && !rental && !venue && ["resource", "date", "time"].includes(ask);
  const [staff, setStaff] = useState({ key: null, options: [] });
  const staffKey = `${selected.offeringId}|${selected.durationMinutes ?? ""}|${selected.partySize ?? ""}`;
  useEffect(() => {
    if (!combined) return;
    if (ask === "resource") {
      setStaff({ key: staffKey, options: view.options ?? [] });
      return;
    }
    if (staff.key === staffKey) return;
    let current = true;
    post(`${api}/step`, { selected: { offeringId: selected.offeringId, durationMinutes: selected.durationMinutes, partySize: selected.partySize }, ask: "resource" })
      .then((data) => { if (current) setStaff({ key: staffKey, options: data.options ?? [] }); })
      .catch(() => { if (current) setStaff({ key: staffKey, options: [] }); });
    return () => { current = false; };
  }, [combined, ask, view, staffKey, staff.key, api, selected.offeringId, selected.durationMinutes, selected.partySize]);
  const staffOptions = staff.key === staffKey && staff.options.some((o) => o.value !== null) ? staff.options : [];
  // The defaults the design shows: anyone (when the shop allows it), then the first day with room
  const autoKey = useRef(null);
  // before the screen is painted, so no tap can land between the answer and the next automatic pick
  useLayoutEffect(() => {
    if (!combined || busy || !view?.options) return;
    let pick = null;
    if (ask === "resource" && selected.resourceId === undefined) {
      const any = view.options.find((o) => o.value === null && o.available);
      if (any) pick = ["resource", null];
    } else if (ask === "date" && !selected.date) {
      const first = view.options.find((o) => o.available);
      if (first) pick = ["date", first.value];
    }
    if (!pick) return;
    const key = `${pick[0]}|${JSON.stringify(selected)}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    setPending({ step: pick[0], value: pick[1] });
    run({ selected: { ...selected, [KEY[pick[0]]]: pick[1] }, changed: pick[0] }, { keepNotice: true });
  }, [combined, busy, view, ask, selected, run]);
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
  // what paying in full costs: the price after any reward; offered only when it is more than the deposit
  const fullAmount = shop.deposit?.allowFull && estimate?.short && typeof estimate.amount === "number"
    ? Math.max((estimate.amount ?? 0) - (chosenReward ? rewardOff(chosenReward) : 0), 0)
    : null;
  const canPayFull = fullAmount !== null && depositAmount > 0 && fullAmount > depositAmount;
  const paying = canPayFull && payFull ? fullAmount : depositAmount;

  // the tapped choice lights up at once; the server's answer follows
  const choose = (step, value) => {
    setPending({ step, value });
    return run({ selected: { ...selected, [KEY[step]]: value }, changed: step });
  };
  // The bottom bar's button: on to the next thing not chosen yet (a step already answered can be left
  // as it is), or to the form once everything is chosen
  const canContinue = Boolean(ask && next?.step && next.step !== ask && next.step !== "start");
  const continueOn = () => (STEP_KEYS.includes(next.step) ? showStep(next.step) : run({ selected }));
  const continueLabel = !canContinue
    ? ""
    : next.step === "resource"
      ? `ต่อไป: เลือก${resourceWord}`
      : next.step === "date"
        ? (rental ? "ต่อไป: วันรับ" : "ต่อไป: เลือกวัน")
        : next.step === "time"
          ? "ต่อไป: เลือกเวลา"
          : next.step === "duration"
            ? "ต่อไป: ระยะเวลา"
            : next.step === "addons"
              ? "ต่อไป: ตัวเลือกเสริม"
              : next.step === "party"
                ? "ต่อไป: จำนวนคน"
                : STEP_KEYS.includes(next.step)
                  ? "ต่อไป"
                  : "ต่อไป: ข้อมูลผู้จอง";
  // "จองซ้ำ": last time's service (and stylist, if the customer can still pick them); then the day
  const rebook = (last) => {
    const resourceId = last.resourceId && resources.has(last.resourceId) ? last.resourceId : undefined;
    setPending({ step: "show", value: "rebook" });
    setStepTrail(["offering"]);
    return run({ selected: { offeringId: last.offeringId, ...(resourceId ? { resourceId } : {}) }, changed: resourceId ? "resource" : "offering" });
  };
  const showStep = (step) => {
    setPending({ step: "show", value: step });
    return run({ selected, ask: step });
  };
  const GROUPED = ["resource", "date", "time"];
  // on the one-screen stylist/day/time step, back goes to what came before it (the service)
  const backStep = atCustomer
    ? stepTrail.at(-1)
    : combined
      ? [...stepTrail].reverse().find((step) => !GROUPED.includes(step)) ?? null
      : stepTrail.length > 1 ? stepTrail.at(-2) : null;
  const backStepLabel = backStep === "resource" ? resourceWord : (rental && RENTAL_TITLE[backStep]) || STEP_TITLE[backStep] || "ขั้นตอนก่อนหน้า";

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
      const result = await post(`${api}/bookings`, { selected, customer, lineIdToken: liff.idToken || undefined, rewardId: rewardId || undefined, payFull: canPayFull && payFull ? true : undefined });
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
          <BookingDone shop={shop} booking={booking} items={summaryItems} selected={selected} resourceWord={resourceWord} customerName={customer.name}
            onSlip={(view) => setBooking((b) => ({ ...b, status: view.booking.status, deposit: { ...b.deposit, slips: view.booking.deposit?.slips ?? 1 } }))} />
          <PoweredBy />
        </main>
      </CustomerFrame>
    );
  }

  const categories = ask === "offering" ? [...new Set((view?.options ?? []).map((o) => offerings.get(o.value)?.category).filter(Boolean))] : [];
  const shownOptions = (view?.options ?? []).filter((o) => ask !== "offering" || !category || categories.length < 2 || offerings.get(o.value)?.category === category);
  // big photo cards when every resource has a photo (only physical resources use billboard layout)
  const pictured = shownOptions.filter((o) => o.value !== null);
  const photoCards =
    pictured.length > 0 &&
    (ask === "resource" && pictured.every((o) => withMedia(resources.get(o.value))));
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
  const dateOptionProps = (o) => {
    const tapped = pending?.step === "date" && pending.value === o.value;
    const chosen = pending?.step === "date" ? tapped : selected.date === o.value;
    return {
      type: "button",
      className: "bk-option",
      "data-testid": "option-date",
      "data-value": String(o.value),
      "data-selected": chosen,
      "data-pending": tapped || undefined,
      "data-unavailable": !o.available || undefined,
      "aria-pressed": chosen,
      disabled: busy || !o.available,
      onClick: () => choose("date", o.value)
    };
  };
  const optionButton = (o) => {
    const tapped = pending?.step === ask && pending.value === o.value;
    const chosen = pending?.step === ask ? tapped : selected[KEY[ask]] === o.value;
    const button = (
      <button key={String(o.value)} {...optionProps(o)}>
        <OptionBody ask={ask} option={o} offering={offerings.get(o.value)} resource={resources.get(o.value)} resourceWord={resourceWord} date={selected.date} shop={shop} chosen={chosen} />
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
      <main className={liffId && atStart && !selected.offeringId ? "bk-shell bk-with-tabs" : "bk-shell"} aria-busy={busy}>
        <ShopHeader shop={shop} subtitle="จองคิวออนไลน์ · เลือกจากคิวว่างของร้าน" />
        {backStep && (
          <button type="button" className="bk-flow-back" onClick={() => showStep(backStep)} disabled={busy}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M9 12h11" /></svg>
            <span>ย้อนกลับ</span>
            <small>ไปยัง{backStepLabel}</small>
          </button>
        )}
        {!atCustomer && summaryItems.length === 0 && (
          <MemberWelcome liff={liff} welcome={welcome} slug={shop.slug} busy={busy}
            rebook={welcome?.last && offerings.has(welcome.last.offeringId) ? welcome.last : null} onRebook={rebook} />
        )}
        {/* the venue's details while the customer is still looking; out of the way once they start picking */}
        {!atCustomer && summaryItems.length === 0 && <ShopAbout shop={shop} />}
        <BookingProgress phase={atCustomer ? "customer" : "selection"} ask={combined ? "time" : ask} resourceWord={resourceWord} />

        {!atCustomer && summaryItems.some((item) => !(combined && GROUPED.includes(item.step))) && (
          <nav className="bk-chips" aria-label="ที่เลือกไว้">
            {summaryItems.filter((item) => !(combined && GROUPED.includes(item.step))).map((item) => (
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
            <div className="bk-step-head">
              <h2>{combined || ask === "time" ? "เลือกวันและเวลา" : ask === "resource" ? `เลือก${resourceWord}` : (rental && RENTAL_TITLE[ask]) || STEP_TITLE[ask]}</h2>
              {ask === "time" && selected.date && (rental || !combined) && (
                <p className="bk-muted">
                  {rental ? "เลือกเวลาที่สะดวกรับ · คืนเวลาเดียวกัน" : "เลือกเวลาว่างของร้านในวันที่เลือก"}
                  {rental && selected.durationMinutes ? ` วัน${returnDay(selected.date, selected.durationMinutes)}` : ""}
                </p>
              )}
              {ask === "duration" && rental && <p className="bk-muted">เช่าเป็นรอบ 24 ชม. คืนเวลาเดียวกับที่รับ</p>}
            </div>
            {ask === "time" && selected.date && !dateOptions.length && (
              <div className="bk-time-date-card">
                <span className="bk-time-date-icon" aria-hidden="true"><CalendarIcon /></span>
                <span className="bk-time-date-copy"><small>วันที่เลือก</small><strong>{formatDate(selected.date, { long: true })}</strong></span>
                <button type="button" onClick={() => showStep("date")} disabled={busy}>เปลี่ยนวัน</button>
              </div>
            )}
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
            {combined && staffOptions.length > 0 && (
              <StaffRow
                options={ask === "resource" ? view.options : staffOptions}
                resources={resources}
                resourceWord={resourceWord}
                chosen={pending?.step === "resource" ? pending.value : selected.resourceId}
                busy={busy}
                onChoose={(value) => choose("resource", value)}
              />
            )}
            {combined && ask === "resource" ? (
              <p className="bk-muted bk-combined-hint">เลือก{resourceWord}ด้านบน แล้วเลือกวันและเวลาที่ว่าง</p>
            ) : combined && ask === "date" ? (
              <>
                <DateStrip options={view.options} today={todayIn(shop.timezone)} optionProps={optionProps} />
                <p className="bk-muted bk-combined-hint">เลือกวันเพื่อดูเวลาที่ว่าง</p>
              </>
            ) : ask === "addons" ? (
              <AddonsStep key={`${selected.date}-${selected.time}`} view={view} info={addonInfo} initial={selected.addons} busy={busy} onDone={(picks) => choose("addons", picks)} />
            ) : ask === "date" ? (
              <DateStrip options={view.options} today={todayIn(shop.timezone)} optionProps={optionProps} />
            ) : ask === "time" ? (
              <>
                {selected.date && dateOptions.length > 0 && (
                  <section className="bk-time-date-section" aria-labelledby="bk-time-date-title">
                    <div className="bk-time-date-heading">
                      <h3 id="bk-time-date-title">{rental ? "เลือกวันรับ" : "เลือกวันที่"}</h3>
                      <span>{formatDate(selected.date, { long: true })}</span>
                    </div>
                    <DateStrip options={dateOptions} today={todayIn(shop.timezone)} optionProps={dateOptionProps} />
                  </section>
                )}
                <TimeTabs options={view.options} optionButton={optionButton} />
              </>
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
          </section>
        )}

        {/* what has been picked so far, the price, and the way on — on every step until the form */}
        {ask && summaryItems.length > 0 && (
          <div className="bk-step1-drawer" data-testid="pick-bar" data-action={canContinue || undefined}>
            <div className="bk-step1-drawer-inner">
              <div className="bk-step1-drawer-info">
                <span className="bk-pick-bar-what">{summaryItems.map((item) => (item.step === "date" ? shortDate(selected.date) : item.value)).join(" · ")}</span>
                <strong className="bk-pick-bar-price">{shownPrice?.short ?? (offerings.get(selected.offeringId)?.price ? priceText(offerings.get(selected.offeringId).price) : "เลือกต่อด้านบน")}</strong>
              </div>
              {canContinue && (
                <button type="button" className="bk-primary bk-step1-drawer-cta" disabled={busy} onClick={continueOn}>
                  <span>{continueLabel}</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </button>
              )}
            </div>
          </div>
        )}

        {atCustomer && (
          <>
            <ConfirmSummary
              selected={selected}
              items={summaryItems}
              price={shownPrice}
              deposit={Boolean(shop.deposit)}
              busy={busy}
              onEdit={() => showStep(selected.time && !rental && !venue ? "time" : summaryItems.at(-1)?.step ?? "offering")}
            />
            {liff.name ? (
              <div className="bk-line-connected-card">
                <div className="bk-line-avatar-wrap">
                  <div className="bk-line-avatar">
                    <span className="bk-line-initial">{(customer.name || liff.name)[0]}</span>
                    {liff.pictureUrl && <img src={liff.pictureUrl} alt={liff.name} onError={(e) => e.currentTarget.remove()} />}
                  </div>
                  <span className="bk-line-chat-badge" aria-hidden="true">💬</span>
                </div>
                <div className="bk-line-info">
                  <div className="bk-line-status-row">
                    <span className="bk-line-tag">เชื่อมต่อ LINE แล้ว</span>
                    <span className="bk-line-dot-sep">•</span>
                    <span className="bk-line-subtag">ดึงข้อมูลอัตโนมัติ</span>
                  </div>
                  <p className="bk-line-name">คุณ {customer.name || liff.name}</p>
                </div>
                <span className="bk-line-verified" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--mint-deep)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </span>
              </div>
            ) : null}

            <form id="booking-customer" className="bk-card bk-customer-form" onSubmit={submit}>
              <div className="bk-customer-form-head">
                <div className="bk-customer-form-title">
                  <span className="bk-icon-pill">🪪</span>
                  <h2>ข้อมูลผู้รับบริการ</h2>
                </div>
                <span className="bk-muted-badge">แก้ไขได้</span>
              </div>

              <div className="bk-field-group">
                <label className="bk-field" htmlFor="cust-name">
                  <span className="bk-field-label">ชื่อ-นามสกุล (ผู้เข้ารับบริการ) <strong className="bk-req">*</strong></span>
                  <div className="bk-input-wrap">
                    <span className="bk-input-icon" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>
                    </span>
                    <input
                      id="cust-name"
                      name="name"
                      required
                      maxLength={100}
                      autoComplete="name"
                      placeholder="ระบุชื่อ-นามสกุล"
                      value={customer.name}
                      onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                    />
                  </div>
                </label>

                <label className="bk-field" htmlFor="cust-phone">
                  <span className="bk-field-label">เบอร์โทรศัพท์สำหรับติดต่อ {!liff.idToken && <strong className="bk-req">*</strong>}</span>
                  <div className="bk-input-wrap">
                    <span className="bk-input-icon" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    </span>
                    <input
                      id="cust-phone"
                      name="phone"
                      inputMode="tel"
                      autoComplete="tel"
                      required={!liff.idToken}
                      pattern="0[0-9\- ]{8,11}"
                      placeholder="08x-xxx-xxxx"
                      value={customer.phone}
                      onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
                    />
                  </div>
                  <p className="bk-field-hint">
                    <span>💬</span>
                    <span>ใช้เบอร์นี้สำหรับติดต่อเกี่ยวกับการจอง</span>
                  </p>
                </label>

                <label className="bk-field" htmlFor="cust-note">
                  <span className="bk-field-label">ฝากถึงร้าน <small className="bk-muted">(ไม่บังคับ)</small></span>
                  <div className="bk-input-wrap">
                    <textarea
                      id="cust-note"
                      name="note"
                      rows={2}
                      maxLength={300}
                      placeholder="เช่น ขอสระด้วยน้ำอุ่น หรือทรงที่อยากได้"
                      value={customer.note || ""}
                      onChange={(e) => setCustomer({ ...customer, note: e.target.value })}
                    />
                  </div>
                </label>
              </div>
              {shop.deposit && !canPayFull && <DepositNote deposit={shop.deposit} estimate={estimate} />}
            </form>

            {points && !points.none && points.rewards.length > 0 && (
              <PointsChoice points={points} chosen={rewardId} onChoose={setRewardId} busy={busy} valueOf={rewardOff} />
            )}

            {canPayFull && (
              <PayChoice deposit={depositAmount} full={fullAmount} payFull={payFull} onChoose={setPayFull} busy={busy} holdMinutes={shop.deposit.holdMinutes} />
            )}
            {(shop.selfService?.cancel || shop.selfService?.reschedule) && (
              <p className="bk-confirm-policy">
                {shop.selfService?.reschedule && shop.selfService?.cancel ? "เลื่อนหรือยกเลิก" : shop.selfService?.reschedule ? "เลื่อน" : "ยกเลิก"}เองได้ถึง{" "}
                <b>{shop.selfService?.cutoffHours ?? shop.cancellation_lead_hours ?? 2} ชม.</b> ก่อนนัด จากลิงก์ที่ได้หลังจอง · ข้อมูลของคุณใช้เพื่อการนัดหมายนี้เท่านั้น
              </p>
            )}

          </>
        )}
        {atCustomer && (
          <BookingSubmitBar
            formId="booking-customer"
            disabled={busy || !liff.ready}
            busy={busy}
            price={shownPrice?.short}
            deposit={paying}
            payFull={canPayFull && payFull}
          />
        )}
        <PoweredBy />
      </main>
      {liffId && atStart && !selected.offeringId && <CustomerTabs slug={shop.slug} active="book" />}
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

// Dates and times follow Stitch's single-screen picker: one date strip, then every available
// period with its start times. The server remains the source of date and slot availability.
const PART_ICON = { morning: "☀️", afternoon: "⛅", evening: "🌙" };
function TimeTabs({ options, optionButton }) {
  const parts = groupTimes(options);
  if (!parts.length) return null;
  return (
    <div className="bk-time-groups">
      {parts.map((part) => (
        <section className="bk-time-group" key={part.key} aria-labelledby={`bk-time-${part.key}`}>
          <h3 className="bk-time-group-head" id={`bk-time-${part.key}`}>
            <span><span aria-hidden="true">{PART_ICON[part.key]}</span> {part.label}</span>
            <small>{`ว่าง ${part.options.filter((o) => o.available).length} เวลา`}</small>
          </h3>
          <div className="bk-options bk-options-time" role="group" aria-label={`เวลา${part.label}`}>
            {part.options.map(optionButton)}
          </div>
        </section>
      ))}
    </div>
  );
}

// "ใช้คะแนน" (migration …003200): a LINE member picks one reward; its points are set aside with the
// booking and the discount comes off at the desk. Rewards they cannot use yet say why.
// What is being booked, on top of the form (design Confirm): the day in a tile, the service, when and
// with whom, the extras, the price — and one way back to change it
function ConfirmSummary({ selected, items, price, deposit, busy, onEdit }) {
  const by = (step) => items.find((item) => item.step === step)?.value;
  const when = [selected.date ? shortDate(selected.date) : null, selected.time ? `${selected.time} น.` : null, by("resource")].filter(Boolean).join(" · ");
  const more = items.filter((item) => !["date", "time", "offering", "resource"].includes(item.step));
  const tile = selected.date ? new Date(`${selected.date}T00:00:00Z`) : null;
  return (
    <section className="bk-card bk-confirm-summary" aria-labelledby="confirm-summary-title" data-testid="confirm-summary">
      <div className="bk-confirm-row">
        {tile && (
          <span className="bk-date-tile bk-confirm-tile" aria-hidden="true">
            <small>{new Intl.DateTimeFormat("th-TH", { timeZone: "UTC", month: "short" }).format(tile)}</small>
            <strong>{tile.getUTCDate()}</strong>
          </span>
        )}
        <div className="bk-confirm-what">
          <strong id="confirm-summary-title">{by("offering") ?? "นัดหมาย"}</strong>
          {when && <span>{when}</span>}
          {more.map((item) => <small key={item.step}>{item.label}: {item.value}</small>)}
        </div>
        <button type="button" className="bk-text-button bk-confirm-edit" disabled={busy} onClick={onEdit}>แก้ไข</button>
      </div>
      {price?.value && (
        <div className="bk-confirm-price">
          <span>{price.label}</span>
          <strong>{price.value}{deposit ? "" : " · จ่ายที่ร้าน"}</strong>
        </div>
      )}
    </section>
  );
}

// Stylists as a row of round faces (design DateTime): "anyone" first, then each one; a full one is grey
function StaffRow({ options, resources, resourceWord, chosen, busy, onChoose }) {
  return (
    <>
    <span className="bk-staff-label">{resourceWord}</span>
    <div className="bk-staff-row" role="radiogroup" aria-label={`เลือก${resourceWord}`}>
      {options.map((o) => {
        const resource = o.value === null ? null : resources.get(o.value);
        const on = chosen === o.value;
        return (
          <button
            key={o.value ?? "any"}
            type="button"
            role="radio"
            className="bk-staff"
            data-testid="option-resource"
            data-value={o.value === null ? "any" : o.value}
            data-selected={on}
            aria-checked={on}
            disabled={busy || !o.available}
            onClick={() => onChoose(o.value)}
          >
            <span className="bk-staff-face" aria-hidden="true">
              {o.value === null ? "✱" : <ResourceThumbnail resource={resource ?? { name: o.label }} />}
            </span>
            <span className="bk-staff-name">{o.value === null ? "ใครก็ได้" : resource?.name ?? o.label}</span>
            {!o.available && <small className="bk-staff-reason">ไม่ว่าง</small>}
          </button>
        );
      })}
    </div>
    </>
  );
}

// The first thing a LINE member sees: their LINE picture and name, tier, points, and the next booking
// still to come. Outside LINE (a browser, with the shop's LIFF app set up): one tap to sign in with LINE.
function MemberWelcome({ liff, welcome, slug, rebook = null, onRebook, busy = false }) {
  if (!liff.idToken) {
    if (!liff.login) return null;
    return (
      <section className="bk-member bk-member-login" data-testid="member-login">
        <span className="bk-member-line" aria-hidden="true">LINE</span>
        <span className="bk-member-copy">
          <strong>เข้าสู่ระบบด้วย LINE</strong>
          <small>จองเร็วขึ้น · สะสมคะแนน · ดูการจองของคุณ</small>
        </span>
        <button type="button" className="bk-member-button" onClick={liff.login}>เข้าสู่ระบบ</button>
      </section>
    );
  }
  const name = welcome?.customer?.name || liff.name;
  const visits = welcome?.customer?.visits ?? 0;
  const points = welcome?.points;
  const next = welcome?.next;
  return (
    <section className="bk-member" data-testid="member-welcome" aria-label="สมาชิก">
      <div className="bk-member-head">
        <span className="bk-member-avatar" aria-hidden="true">
          <span>{(name || "?")[0]}</span>
          {liff.pictureUrl && <img src={liff.pictureUrl} alt="" onError={(e) => e.currentTarget.remove()} />}
        </span>
        <span className="bk-member-copy">
          <small>{welcome?.customer ? (visits > 0 ? `ยินดีต้อนรับกลับมา · มาแล้ว ${visits} ครั้ง` : "ยินดีต้อนรับกลับมา") : "ยินดีต้อนรับ"}</small>
          <strong>คุณ {name || "ลูกค้า"}</strong>
        </span>
        {points?.tier && <span className="bk-member-tier">{points.tier.name}</span>}
      </div>
      {(points || next) && (
        <div className="bk-member-stats">
          {points && (
            <a className="bk-member-stat" href={`/b/${slug}/me`}>
              <small>คะแนนสะสม</small>
              <strong>{points.balance.toLocaleString("th-TH")} <span>คะแนน</span></strong>
              {points.usable > 0 && <em>แลกได้ {points.usable} รางวัล</em>}
            </a>
          )}
          {next && (
            <a className="bk-member-stat" href={next.link ?? `/b/${slug}/me`} data-testid="member-next">
              <small>นัดถัดไป</small>
              <strong>{shortDate(next.date)} · {next.start} น.</strong>
              <em>{next.offering}{["held", "pending"].includes(next.status) ? " · รอชำระ/ตรวจสลิป" : ""}</em>
            </a>
          )}
        </div>
      )}
      {rebook && (
        <button type="button" className="bk-member-rebook" data-testid="member-rebook" disabled={busy} onClick={() => onRebook?.(rebook)}>
          <span className="bk-member-rebook-icon" aria-hidden="true">↻</span>
          <span className="bk-member-copy">
            <strong>จองซ้ำ</strong>
            <small>{rebook.offering}{rebook.resource ? ` · ${rebook.resource}` : ""}</small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      )}
      <a className="bk-member-link" href={`/b/${slug}/me`}>บัตรสมาชิกและประวัติการจอง ›</a>
    </section>
  );
}

// Deposit or the whole price, the customer's choice (migration …003800). Either way the booking waits
// for the transfer; paying in full leaves nothing to pay at the shop.
function PayChoice({ deposit, full, payFull, onChoose, busy, holdMinutes }) {
  const choices = [
    { value: false, title: `มัดจำ ${money(deposit)}`, meta: `ส่วนที่เหลือ ${money(full - deposit)} จ่ายที่ร้าน` },
    { value: true, title: `จ่ายเต็มจำนวน ${money(full)}`, meta: "ไม่ต้องจ่ายเพิ่มที่ร้าน" }
  ];
  return (
    <section className="bk-card bk-pay-choice" aria-labelledby="pay-choice-title" data-testid="pay-choice">
      <h2 id="pay-choice-title">เลือกวิธีชำระ</h2>
      <div className="bk-options bk-options-reward" role="radiogroup" aria-label="เลือกวิธีชำระ">
        {choices.map((c) => (
          <button key={String(c.value)} type="button" className="bk-option" role="radio" aria-checked={payFull === c.value} data-selected={payFull === c.value}
            disabled={busy} onClick={() => onChoose(c.value)}>
            <span className="bk-option-text">
              <strong>{c.title}</strong>
              <span className="bk-option-meta"><span>{c.meta}</span></span>
            </span>
            <span className="bk-choice-mark" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="bk-fine">หลังกดยืนยันจะแสดง QR และเวลาส่งสลิป {formatMinutes(holdMinutes ?? 10)}</p>
    </section>
  );
}

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

function LocationIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" />
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
      ร้านนี้ขอมัดจำ <b>{what}</b> · หลังกดยืนยันจะแสดงวิธีชำระและเวลาส่งสลิป {formatMinutes(deposit.holdMinutes ?? 10)}
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

function BookingDone({ shop, booking, items, selected, resourceWord, customerName = "", onSlip }) {
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
  // "anyone" was picked and the shop gave someone: one line with who it is, not "anyone" as well
  const showAssigned = booking.resources?.length > 0 && selected.resourceId == null;
  const rows = items.filter((item) => item.step !== "date" && item.step !== "time" && !(showAssigned && item.step === "resource"));
  const managePath = booking.manageToken ? `/b/${shop.slug}/manage/${booking.manageToken}` : null;
  const held = booking.status === "held";
  const pendingStatus = booking.status === "pending";
  const statusLabel = held ? "รอชำระมัดจำ" : pendingStatus ? "รอร้านตรวจสอบ" : booking.status === "confirmed" ? "ยืนยันแล้ว" : "รอรับบริการ";
  const successTitle = held ? "กันคิวไว้ให้แล้ว" : pendingStatus ? "ส่งสลิปแล้ว รอร้านยืนยัน" : "จองคิวสำเร็จแล้ว";
  const successCopy = held && booking.deposit
    ? booking.deposit.payFull ? "ชำระเต็มจำนวนตามรายละเอียดด้านล่างเพื่อยืนยันคิว" : "ชำระมัดจำตามรายละเอียดด้านล่างเพื่อยืนยันคิว"
    : pendingStatus
      ? "ร้านกำลังตรวจสอบสลิป คุณดูสถานะการจองได้จากลิงก์ด้านล่าง"
      : customerName.trim()
        ? `${shop.name} รอพบคุณ${customerName.trim().split(/\s+/)[0]}`
        : `${shop.name} รอพบคุณ`;
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
      <div className="bk-done-head" data-state={held ? "held" : pendingStatus ? "pending" : "confirmed"} role="status" aria-live="polite">
        <span className="bk-done-icon" aria-hidden="true">
          {held || pendingStatus
            ? <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            : <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
        </span>
        <h1>{successTitle}</h1>
        <p className="bk-muted">{successCopy}</p>
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

      {/* the booking in one card (design "Kiwmee ปรับหน้าตา" · Done): when, what, who, how much, and the
          two things people do next — put it in their calendar, find the way */}
      <div className="bk-card bk-done-card">
        <div className="bk-done-meta">
          {booking.id && <span>รหัสการจอง <b>#{bookingCode(booking.id)}</b></span>}
          <span className="bk-done-status" data-state={held ? "held" : pendingStatus ? "pending" : "confirmed"}>{statusLabel}</span>
        </div>
        {selected.date && (
          <div className="bk-done-schedule">
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
            {booking.price?.total > 0 && (
              <div className="bk-done-total"><small>{booking.deposit ? "ราคารวม" : "จ่ายที่ร้าน"}</small><strong>{money(booking.price.total)}</strong></div>
            )}
          </div>
        )}
        <dl className="bk-summary bk-done-summary">
          {rows.map((item) => (
            <div key={item.step}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
          {showAssigned && (
            <div>
              <dt>{givenWord}</dt>
              <dd>
                {assigned || "ร้านจัดให้"}
                {assigned && items.some((item) => item.step === "resource") && <><br /><small className="bk-muted">ระบบเลือกให้</small></>}
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
        {held && booking.holdExpiresAt && !booking.deposit && <p className="bk-notice">กรุณาชำระเงินภายใน {timeFormat(booking.holdExpiresAt)} น.</p>}
        {shop.address && <p className="bk-done-address"><LocationIcon /> <span>{shop.address}</span></p>}
        <div className="bk-done-actions">
          {booking.startAt && booking.endAt && (
            <button type="button" className="bk-done-action" onClick={addToCalendar}>เพิ่มลงปฏิทิน</button>
          )}
          {shop.directions && (
            <a className="bk-done-action" href={shop.directions} target="_blank" rel="noreferrer">ดูเส้นทาง</a>
          )}
          <button type="button" className="bk-done-action" onClick={shareBooking}>{shared ? "✓ คัดลอกแล้ว" : "ส่งให้เพื่อน"}</button>
        </div>
      </div>

      {/* the check-in QR once the booking counts: not while the deposit is still awaited */}
      {booking.id && (held || pendingStatus) && <p className="bk-qr-wait">QR เช็กอินจะแสดงเมื่อร้านยืนยันมัดจำแล้ว</p>}
      {booking.id && !held && !pendingStatus && (
        <div className="bk-card bk-done-qr">
          <strong className="bk-done-qr-title">QR เช็กอินเมื่อถึงร้าน</strong>
          <CheckinQr slug={shop.slug} id={booking.id} open={true} />
        </div>
      )}

      {managePath && <ManageLink shop={shop} path={managePath} />}

      <a className="bk-again" href={`/b/${shop.slug}`}>จองคิวอีกครั้ง</a>

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

function OptionBody({ ask, option, offering, resource, resourceWord, date, shop, chosen = false }) {
  if (ask === "offering" && offering) {
    const length = offeringLength(offering);
    const depVal = shop?.deposit?.mode === "fixed" ? shop.deposit.value : shop?.deposit?.mode === "percent" && offering.price?.amount ? Math.round((offering.price.amount * shop.deposit.value) / 100) : null;
    const isSelected = Boolean(chosen || option?.["data-selected"]);
    // booked most here in the last 30 days (shopInfo counts real bookings)
    const isPopular = offering.popular === true;
    // the shop's own choice on its catalogue page, not a guess from the price
    const isPremium = offering.premium === true;

    // one row (design "Kiwmee ปรับหน้าตา" · Main): picture · name, length, price · a tick when chosen
    return (
      <div className="bk-offering-row">
        {withMedia(offering) ? (
          <OfferingThumbnail offering={offering} />
        ) : (
          <span className="bk-offering-initial" aria-hidden="true">{offering.name?.[0] ?? "•"}</span>
        )}
        <span className="bk-offering-row-body">
          {(isPopular || isPremium) && (
            <span className="bk-offering-badges">
              {isPopular ? <span className="bk-badge-popular">ยอดนิยม 🔥</span> : <span className="bk-badge-premium">พรีเมียม ✨</span>}
            </span>
          )}
          <strong className="bk-offering-name">{offering.name}</strong>
          <span className="bk-offering-meta">
            {length}
            {depVal > 0 ? ` · มัดจำ ฿${depVal.toLocaleString("th-TH")}` : ""}
          </span>
          {offering.description && <span className="bk-option-desc">{offering.description}</span>}
          <span className="bk-offering-price">{offering.price ? priceText(offering.price) : "ฟรี"}</span>
        </span>
        <span className="bk-choice-mark" aria-hidden="true" data-on={isSelected || undefined} />
      </div>
    );
  }
  if (ask === "resource") return <ResourceChoice resource={resource} label={option.label} resourceWord={resourceWord} any={option.value === null} />;
  if (ask === "date") return <DateBody value={option.value} />;
  if (ask === "time") return <><strong>{option.value}</strong><small className="bk-time-slot-available">คิวว่าง</small></>;
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
